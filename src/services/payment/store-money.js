'use strict';

const unknown = () => ({ amountMinor: null, currency: null });
function scaledMoney(value, scale, currency) {
  if (!/^[A-Z]{3}$/.test(String(currency || ''))) return unknown();
  try {
    const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
      .maximumFractionDigits;
    const scaled = BigInt(value) * 10n ** BigInt(digits),
      divisor = 10n ** BigInt(scale);
    if (
      scaled < 0n ||
      scaled % divisor !== 0n ||
      scaled / divisor > BigInt(Number.MAX_SAFE_INTEGER)
    )
      return unknown();
    return { amountMinor: Number(scaled / divisor), currency };
  } catch {
    return unknown();
  }
}
// Apple price is in milliunits: https://developer.apple.com/documentation/appstoreserverapi/price
function appleMoney(transaction) {
  return Number.isSafeInteger(transaction?.price)
    ? scaledMoney(transaction.price, 3, transaction.currency)
    : unknown();
}
function googleMoney(money) {
  if (!money || !/^-?\d+$/.test(String(money.units ?? '0')) || !Number.isInteger(money.nanos ?? 0))
    return unknown();
  return scaledMoney(
    BigInt(money.units ?? '0') * 1000000000n + BigInt(money.nanos ?? 0),
    9,
    money.currencyCode
  );
}
async function googleOrderMoney(publisher, packageName, orderId, refund = false) {
  if (!publisher?.orders?.get || !orderId) return unknown();
  try {
    // Use charged order total, not a catalog or recurring display price.
    // https://developers.google.com/android-publisher/api-ref/rest/v3/orders
    const { data } = await publisher.orders.get({ packageName, orderId }, { timeout: 5000 });
    return googleMoney(
      refund ? data?.orderHistory?.refundEvent?.refundDetails?.total : data?.total
    );
  } catch {
    return unknown();
  }
}
function appleRefundMoney(transaction) {
  const total = appleMoney(transaction),
    percent = transaction?.revocationPercentage;
  if (total.amountMinor == null) return total;
  if (percent == null) return transaction?.revocationDate != null ? total : unknown();
  if (!Number.isSafeInteger(percent) || percent < 0 || percent > 100000) return unknown();
  const amount = BigInt(total.amountMinor) * BigInt(percent);
  return amount % 100000n === 0n
    ? { amountMinor: Number(amount / 100000n), currency: total.currency }
    : unknown();
}
module.exports = { appleMoney, appleRefundMoney, googleMoney, googleOrderMoney };
