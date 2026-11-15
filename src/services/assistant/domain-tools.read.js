'use strict';
const c = require('../v21/common');
const { t } = require('../../i18n');
const taskLabel = (code, lang) => ({ CHECKIN: lang === 'en' ? 'Daily check-in' : 'Check-in hằng ngày', MED_ANSWER: lang === 'en' ? 'Medication response' : 'Phản hồi nhắc thuốc', VITAL: lang === 'en' ? 'Record a reading' : 'Ghi chỉ số', GIFT_OPEN: lang === 'en' ? 'Open fortune' : 'Mở lộc', WEEKLY: lang === 'en' ? 'Weekly routine' : 'Duy trì mỗi tuần' }[code] || (lang === 'en' ? 'Health activity' : 'Hoạt động sức khỏe'));
const rewardLabel = (code, lang) => code === 'GREETING_CARD' ? lang === 'en' ? 'Greeting card' : 'Thiệp gửi người thân' : lang === 'en' ? 'Lucky draw ticket' : 'Vé dự thưởng';
const fold = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/đ/g, 'd').trim();
const failed = code => { throw c.error(code || 'APP_ASSISTANT_UNAVAILABLE', 503); };
const checked = result => result?.ok === false ? failed() : result;
const local = value => value ? new Date(value).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }) : '';
const choose = (rows, target, label) => {
  const text = fold(target);
  if (/^(latest|newest|moi nhat|gan nhat|dau tien|first)$/.test(text)) return rows[0] || null;
  const position = text.match(/^(?:(?:thu|so|number|#|thong bao thu)\s*)?(\d+)$/);
  if (position) return rows[Number(position[1]) - 1] || null;
  const exact = rows.filter(row => fold(label(row)) === text);
  if (exact.length === 1) return exact[0];
  const matches = rows.filter(row => text && fold(label(row)).includes(text));
  return matches.length === 1 ? matches[0] : null;
};
const describeGift = gift => gift ? [gift.day, gift.loc?.text, gift.ticket ? `${gift.ticket.number} · ${gift.ticket.period} · ${gift.ticket.drawAt}` : ''].filter(Boolean).join('\n') : '';
async function notifications(db, owner) {
  return checked(await require('../notification/notification.service').getNotifications(db, owner, { page: 1, limit: 100 })).notifications;
}
async function connections(db, owner, lang) {
  return checked(await require('../care-circle/careCircle.service').getConnections(db, owner, lang)).connections.map(row => {
    const requester = Number(row.requester_id) === Number(owner);
    return { ...row, name: requester ? row.addressee_full_name : row.requester_full_name,
      otherId: requester ? row.addressee_id : row.requester_id,
      sharingMine: requester ? row.permissions?.can_view_logs === true : row.addressee_can_view_logs === true,
      canViewTheirs: requester ? row.addressee_can_view_logs === true : row.permissions?.can_view_logs === true };
  });
}
async function invitations(db, owner, lang) {
  const rows = checked(await require('../care-circle/careCircle.service').getInvitations(db, owner, 'all', lang)).invitations;
  return rows.map(row => ({ ...row, received: Number(row.addressee_id) === Number(owner),
    name: Number(row.addressee_id) === Number(owner) ? row.requester_full_name : row.addressee_full_name }));
}
async function latestCheckin(db, owner, date) {
  return (await db.query(`SELECT * FROM health_checkins WHERE user_id=$1
    AND ($2::date IS NULL OR session_date=$2::date) ORDER BY session_date DESC,updated_at DESC LIMIT 1`, [owner, date || null])).rows[0];
}
async function feed(db, owner, lang = 'vi', context = {}) {
  const rows = require('../health_feed/config').isHealthFeedEnabled() ? await require('../health_feed/repository').listFeed(db, owner) : [];
  if (rows.length || context.allowCuratedArticles === false) return rows;
  return require('./bundled-feed.json')[lang === 'en' ? 'en' : 'vi'].filter(row => !(context.hiddenArticles || []).includes(row.id));
}

function factorLabel(code, en) {
  const values = {
    status_tired: ['Check-in ghi nhận hơi mệt', 'Check-in reported tiredness'], triage_severity_medium: ['Kết quả check-in cần theo dõi', 'Check-in needs monitoring'],
    triage_severity_high: ['Kết quả check-in cần chú ý', 'Check-in needs attention'], triage_severity_emergency: ['Kết quả check-in có dấu hiệu khẩn cấp', 'Check-in recorded urgent signs'],
    emergency_triggered: ['Đã ghi nhận cảnh báo khẩn cấp', 'An urgent alert was recorded'], glucose_high: ['Đường huyết cao', 'High glucose'],
    glucose_very_high: ['Đường huyết rất cao', 'Very high glucose'], glucose_very_low: ['Đường huyết thấp', 'Low glucose'],
    systolic_high: ['Huyết áp tâm thu cao', 'High systolic pressure'], systolic_very_high: ['Huyết áp tâm thu rất cao', 'Very high systolic pressure'],
    diastolic_high: ['Huyết áp tâm trương cao', 'High diastolic pressure'], diastolic_very_high: ['Huyết áp tâm trương rất cao', 'Very high diastolic pressure'], blood_pressure_low: ['Huyết áp thấp', 'Low blood pressure'],
  };
  return values[code]?.[Number(en)] || (en ? 'A recorded factor needs attention' : 'Có yếu tố đã ghi nhận cần chú ý');
}
async function read(db, owner, tool, args, lang = 'vi', context = {}) {
  const en = lang === 'en';
  const empty = en ? 'There are no records for this request yet.' : 'Chưa có dữ liệu cho yêu cầu này nhé.';
  let answer;
  if (tool === 'notifications.list') {
    let rows = await notifications(db, owner);
    if (args.unread) rows = rows.filter(row => !row.is_read);
    answer = rows.slice(0, 20).map((row, i) => `${i + 1}. ${row.title}\n${row.message}\n${local(row.created_at)}`).join('\n\n');
  } else if (tool === 'missions.status') {
    const rows = await require('../missions/missions.service').getMissions(db, owner);
    answer = rows.filter(row => ['daily_checkin', 'log_bp', 'log_glucose', 'log_water'].includes(row.mission_key)).map(row => `${t(`mission.${row.mission_key}`, lang)}: ${Math.min(Number(row.progress), Number(row.goal))}/${row.goal}${row.status === 'completed' ? en ? ' (completed)' : ' (đã hoàn thành)' : ''}`).join('\n');
  } else if (tool === 'coins.balance') {
    const coins = await require('../v21/coins.service').today(db, owner);
    const earned = (await db.query(`SELECT COALESCE(sum(delta),0)::int value FROM coin_ledger WHERE user_id=$1
      AND delta>0 AND local_date=(now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date`, [owner])).rows[0].value;
    answer = en ? `Balance: ${coins.balance} health coins. Earned today: ${earned}.` : `Xu sức khỏe hiện có: ${coins.balance} xu. Hôm nay đã nhận: ${earned} xu.`;
    answer += '\n' + coins.tasks.map(row => `${taskLabel(row.task_code, lang)}: ${row.done}/${row.task_code === 'WEEKLY' ? row.weekly_limit : row.daily_limit}`).join('\n');
  } else if (tool === 'coins.history') {
    const { items } = await require('../v21/coins.service').history(db, owner);
    const reason = row => row.reason === 'REDEEM' ? `${en ? 'Redeemed' : 'Đổi'} ${rewardLabel(row.catalog_code, lang)}`
      : row.reason === 'REFUND' ? en ? 'Coins refunded' : 'Hoàn xu' : row.reason === 'EXPIRE' ? en ? 'Coins expired' : 'Xu hết hạn' : taskLabel(row.reason, lang);
    answer = items.map(row => `${local(row.created_at)}: ${Number(row.delta) > 0 ? '+' : ''}${row.delta} ${en ? 'coins' : 'xu'} · ${reason(row)}`).join('\n');
  } else if (tool === 'coins.rules' || tool === 'coins.rewards') {
    const catalog = await require('../v21/coins.service').catalog(db, owner);
    answer = catalog.items.map(row => `${row.title || rewardLabel(row.code, lang)}: ${row.cost} ${en ? 'coins' : 'xu'}`).join('\n');
    if (tool === 'coins.rules') {
      const rules = (await db.query('SELECT task_code,coins,daily_limit,weekly_limit FROM coin_rules WHERE active ORDER BY task_code')).rows;
      answer = rules.map(row => `${taskLabel(row.task_code, lang)}: +${row.coins} xu, ${row.weekly_limit > 0 ? `${row.weekly_limit}/${en ? 'week' : 'tuần'}` : `${row.daily_limit}/${en ? 'day' : 'ngày'}`}`).join('\n') + '\n' + answer;
    }
    if (catalog.templates.length) answer += '\n' + (en ? 'Greeting templates: ' : 'Mẫu thiệp: ') + catalog.templates.map(row => en ? row.title_en || row.title : row.title).join('; ');
    if (catalog.recipients.length) answer += '\n' + (en ? 'Connected recipients: ' : 'Người thân có thể nhận: ') + catalog.recipients.map(row => row.name).join(', ');
  } else if (tool === 'gifts.today') {
    const data = await require('../checkin-gifts/gift.service').today(db, owner, lang);
    answer = !data.enabled ? en ? 'Daily fortunes are not enabled.' : 'Lộc mỗi ngày chưa được bật.'
      : data.gift?.openedAt ? describeGift(data.gift) : data.gift ? en ? 'Your fortune is ready. Which box would you like to open, 1 to 6?' : 'Bạn có lộc hôm nay rồi. Bạn muốn mở hộp số mấy, từ 1 đến 6 nhé?'
      : en ? 'There is no eligible fortune yet. Complete your check-in first.' : 'Chưa có lộc đủ điều kiện hôm nay. Bạn hoàn thành check-in trước nhé.';
  } else if (tool === 'gifts.history') {
    const data = await require('../checkin-gifts/gift.service').history(db, owner, null, lang);
    answer = data.items.map(describeGift).join('\n\n');
  } else if (tool === 'family.list') {
    const rows = await connections(db, owner, lang);
    answer = rows.map(row => `${row.name || (en ? 'Relative' : 'Người thân')} · ${row.relationship_type || ''}\n${en ? 'I share my health' : 'Chia sẻ sức khỏe của mình'}: ${row.sharingMine ? en ? 'on' : 'bật' : en ? 'off' : 'tắt'}\n${en ? 'Can view their health' : 'Được xem sức khỏe của họ'}: ${row.canViewTheirs ? en ? 'yes' : 'có' : en ? 'no' : 'chưa'}`).join('\n\n');
  } else if (tool === 'family.invitations') {
    const rows = await invitations(db, owner, lang);
    answer = rows.filter(row => row.status === 'pending').map(row => `${row.name}: ${row.received ? en ? 'received invitation' : 'lời mời đã nhận' : en ? 'sent invitation' : 'lời mời đã gửi'}`).join('\n');
  } else if (tool === 'family.health') {
    const rows = await connections(db, owner, lang), row = choose(rows, args.target, row => row.name);
    if (!row) return { clarify: en ? `Which relative? ${rows.map(row => row.name).join(', ')}` : `Bạn muốn xem sức khỏe của ai: ${rows.map(row => row.name).join(', ')}?` };
    if (!row.canViewTheirs) return { answer: en ? 'This relative has not granted you access to their health data.' : 'Người thân này chưa cho phép bạn xem dữ liệu sức khỏe của họ nhé.' };
    // Consent is directional and checked again by the existing request service.
    const summary = await require('../care-circle/caregiver-view.service').memberHealthSummary(db, owner, row.otherId);
    if (!summary) return { answer: en ? 'Health access was withdrawn.' : 'Quyền xem sức khỏe vừa được thu hồi nhé.' };
    answer = `${row.name}: ${summary.report.checkinDays}/${summary.report.totalDays} ${en ? 'days checked in' : 'ngày có check-in'}.\n` +
      summary.report.sessions.slice(0, 3).map(session => [session.date || session.sessionDate, session.summary].filter(Boolean).join(': ')).join('\n');
    answer += '\n' + (summary.healthScore.factors || []).map(code => factorLabel(code, en)).join('\n');
    return { answer };
  } else if (tool === 'checkin.conclusion') {
    const row = (await db.query(`SELECT triage_summary FROM (
      SELECT triage_summary,COALESCE(triage_completed_at,updated_at) completed FROM health_checkins
        WHERE user_id=$1 AND ($2::date IS NULL OR session_date=$2::date) AND NULLIF(trim(triage_summary),'') IS NOT NULL
      UNION ALL
      SELECT triage_summary,COALESCE(completed_at,snapshot_updated_at) completed FROM health_checkin_occurrences
        WHERE user_id=$1 AND ($2::date IS NULL OR session_date=$2::date) AND NULLIF(trim(triage_summary),'') IS NOT NULL
      ) conclusions ORDER BY completed DESC LIMIT 1`, [owner, args.date || null])).rows[0];
    answer = row?.triage_summary || '';
    if (!answer) answer = empty;
    return { answer, ...(args.speak && row?.triage_summary ? { speech: row.triage_summary } : {}) };
  } else if (tool === 'calls.settings') {
    const data = await require('../checkin-call/checkin-call.service').settings(db, owner);
    answer = `${en ? 'Check-in calls' : 'Cuộc gọi hỏi thăm'}: ${data.enabled ? en ? 'on' : 'bật' : en ? 'off' : 'tắt'}\n${en ? 'Call time' : 'Giờ gọi'}: ${String(data.checkin_time).slice(0, 5)}\n${en ? 'Grace period' : 'Thời gian chờ'}: ${data.grace_hours} ${en ? 'hours' : 'giờ'}\n${en ? 'User ring' : 'Đổ chuông cho mình'}: ${data.user_timeout_seconds} ${en ? 'seconds' : 'giây'}\n${en ? 'Family ring' : 'Đổ chuông người thân'}: ${data.family_ring_seconds} ${en ? 'seconds' : 'giây'}\n${en ? 'Family confirmation' : 'Chờ người thân xác nhận'}: ${data.family_confirm_minutes} ${en ? 'minutes' : 'phút'}\n${en ? 'Maximum rounds' : 'Số vòng tối đa'}: ${data.max_rounds}`;
  } else if (tool === 'calls.voice') {
    const { preferences: p } = await require('../checkin-call/personalization.service').preferences(db, owner);
    answer = require('./domain-tools.service').changesLabel(Object.fromEntries(['address', 'use_name', 'use_health', 'weather_enabled', 'region'].map(key => [key, p[key]])), en);
  } else if (tool === 'medication.weekly') {
    const { report } = await require('../v21/medication.service').weekly(db, owner, owner);
    answer = en ? `This week: ${report.total} scheduled medicine reminders, ${report.taken} taken, ${report.skipped} skipped. Health coins earned this week: ${report.coins}.`
      : `Tuần này: ${report.total} lượt nhắc thuốc theo lịch, ${report.taken} lượt đã uống, ${report.skipped} lượt bỏ qua. Xu sức khỏe đã nhận tuần này: ${report.coins} xu.`;
  } else if (tool === 'medication.history') {
    await c.assertFeature(db, owner, 'medication');
    const med = require('../v21/medication.service');
    let rows = (await db.query(`SELECT e.state,e.scheduled_at,
      COALESCE(array_agg(d.display_name) FILTER(WHERE d.display_name IS NOT NULL),'{}') names
      FROM med_dose_events e LEFT JOIN med_dose_items d ON d.dose_event_id=e.id AND d.patient_user_id=$1
      WHERE e.patient_user_id=$1 AND e.scheduled_at<=now() AND e.state<>'CANCELLED'
      GROUP BY e.id ORDER BY e.scheduled_at DESC LIMIT 60`, [owner])).rows.map(row => ({ ...row,
        names: row.names.map(name => med.reveal(owner, 'med_dose_items.display_name', name)) }));
    if (args.target) rows = rows.filter(row => row.names.some(name => fold(name) === fold(args.target)));
    const labels = en ? { TAKEN: 'taken', SKIPPED: 'skipped', OUT_OF_MEDS: 'out of medicine', MISSED: 'missed', SCHEDULED: 'awaiting response' }
      : { TAKEN: 'đã uống', SKIPPED: 'bỏ qua', OUT_OF_MEDS: 'hết thuốc', MISSED: 'chưa phản hồi', SCHEDULED: 'chờ phản hồi' };
    answer = rows.slice(0, 30).map(row => `${local(row.scheduled_at)} · ${row.names.join(', ')}: ${labels[row.state] || (en ? 'not answered' : 'chưa phản hồi')}`).join('\n');
  } else if (tool === 'early_signal.latest') {
    const data = await require('../early-signal/early-signal-request.service').latest(db, owner, {}, lang);
    const row = data?.assessment || data;
    answer = [row?.summary, ...(row?.signals || []), ...(row?.urgent_signs || []), row?.disclaimer].filter(Boolean).join('\n');
  } else if (tool === 'tree.status') {
    const data = checked(await require('../tree/tree.service').getTreeSummary(db, owner));
    const status = en ? { ok: 'Stable', stable: 'Stable', monitor: 'Monitor', danger: 'Needs attention', unknown: 'Not enough data' } : { ok: 'Ổn định', stable: 'Ổn định', monitor: 'Theo dõi', danger: 'Cần chú ý', unknown: 'Chưa đủ dữ liệu' };
    answer = `${en ? 'Health tree' : 'Cây sức khỏe'}: ${status[data.status] || (en ? 'Not enough data' : 'Chưa đủ dữ liệu')}\n` + (data.healthStatus?.factors || []).map(row => typeof row === 'string' ? factorLabel(row, en) : row.message || row.label || '').filter(Boolean).join('\n');
  } else if (tool === 'wallet.status') {
    const result = await require('../payment/payment.service').getBalance(db, owner);
    answer = `${en ? 'Wallet balance' : 'Số dư ví'}: ${Number(result.balance).toLocaleString(en ? 'en-US' : 'vi-VN')} VND.`;
  } else if (tool === 'wallet.history') {
    const result = await require('../payment/payment.service').getHistory(db, owner, { limit: 20 });
    answer = result.payments.map(row => `${local(row.created_at)}: ${Number(row.amount).toLocaleString(en ? 'en-US' : 'vi-VN')} VND · ${({ completed: en ? 'completed' : 'đã hoàn tất', pending: en ? 'pending' : 'đang chờ', failed: en ? 'failed' : 'không thành công' })[row.status] || (en ? 'recorded' : 'đã ghi nhận')}`).join('\n');
  } else if (tool === 'subscription.status') {
    const result = await require('../payment/subscription.service').getStatus(db, owner);
    const { localizedPlanName, planDefinition } = require('../payment/subscription-catalog');
    const plan = planDefinition(result.planCode);
    answer = `${en ? 'Care plan' : 'Gói chăm sóc'}: ${localizedPlanName(result.planCode, lang)}\n${en ? 'Protected members' : 'Số người được bảo vệ'}: ${plan.protectedMemberLimit}\n${en ? 'Connection limit' : 'Giới hạn kết nối'}: ${plan.connectionLimit}`;
    if (result.expiresAt) answer += `\n${en ? 'Expiry' : 'Hết hạn'}: ${local(result.expiresAt)}`;
  } else if (tool === 'subscription.compare') {
    const { PLAN_DEFINITIONS, localizedPlanName } = require('../payment/subscription-catalog');
    answer = Object.values(PLAN_DEFINITIONS).map(row => `${localizedPlanName(row.code, lang)}: ${row.protectedMemberLimit} ${en ? 'protected members' : 'người được bảo vệ'}, ${row.monthlyPriceVnd.toLocaleString('vi-VN')} VND/${en ? 'month' : 'tháng'}, ${row.yearlyPriceVnd.toLocaleString('vi-VN')} VND/${en ? 'year' : 'năm'}`).join('\n');
  } else if (tool === 'feed.search' || tool === 'feed.read') {
    const rows = await feed(db, owner, lang, context);
    if (tool === 'feed.search') {
      const matching = rows.filter(row => !args.query || fold(`${row.title} ${row.message}`).includes(fold(args.query)));
      answer = matching.map((row, i) => `${i + 1}. ${row.title}\n${row.message}`).join('\n\n');
    } else {
      const row = choose(rows, args.target, row => row.title);
      if (!row) return { clarify: en ? `Which article? ${rows.map(row => row.title).join('; ')}` : `Bạn muốn đọc bài nào: ${rows.map(row => row.title).join('; ')}?` };
      return { answer: row.title, screen: { screen: 'feed_article', params: { id: String(row.content_id) } } };
    }
  } else failed('APP_ASSISTANT_INVALID_REQUEST');
  return { answer: answer || empty };
}
module.exports = { read, choose, checked, fold, notifications, connections, invitations, latestCheckin, feed, describeGift };
