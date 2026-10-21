'use strict';

const { randomInt } = require('node:crypto');
const SCALE = 1000000;

// Choose an eligible kind first so a larger wish catalog does not drown out
// proverbs and reviewed tips. Eligibility and the 30-day exclusion live in SQL.
function selectLoc(items, choose = randomInt) {
  const groups = ['wish', 'proverb', 'health_tip']
    .map((type) => items.filter((item) => item.type === type))
    .filter((group) => group.length);
  if (!groups.length) return null;
  const group = groups[choose(groups.length)];
  return group[choose(group.length)];
}

// No answer, streak or plan enters the random draw. Eligibility only folds
// unavailable extra categories back into the ordinary fortune category.
function selectExtra(config, eligibility, value = randomInt(SCALE)) {
  if (!Number.isInteger(value) || value < 0 || value >= SCALE)
    throw new Error('Invalid gift random value');
  const { loc_weight: loc, ticket_weight: ticket, coupon_weight: coupon } = config;
  if (
    ![loc, ticket, coupon].every((x) => Number.isInteger(x) && x >= 0) ||
    loc + ticket + coupon !== 100
  )
    throw new Error('Invalid gift weights');
  if (value < loc * 10000) return 'none';
  if (value < (loc + ticket) * 10000) return eligibility.ticket ? 'ticket' : 'none';
  return eligibility.coupon ? 'coupon' : 'none';
}

module.exports = { selectExtra, selectLoc, SCALE };
