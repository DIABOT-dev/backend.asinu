'use strict';
const { z } = require('zod');
const reminders = require('../notification/reminder-assistant.service');
const evidence = z.string().trim().min(1).max(3000);
const querySchema = z.object({ type: z.literal('query'), topic: z.enum(['water', 'blood_pressure', 'glucose', 'medication', 'checkin', 'profile', 'reminders', 'meal']),
  range: z.enum(['today', 'yesterday', 'week', 'month', 'this_week', 'this_month', 'custom']).default('today'),
  statistic: z.enum(['list', 'latest', 'average', 'min', 'max']).default('list'), startDate: require('./domain-tools.schema').date.optional(), endDate: require('./domain-tools.schema').date.optional(), evidence }).strict();
const navigateSchema = z.object({ type: z.literal('navigate'), destination: z.enum([
  'checkin', 'checkin_history', 'medication', 'logs', 'blood_pressure', 'glucose', 'water', 'consultation', 'profile',
  'reminders', 'notifications', 'care_circle', 'scan_qr', 'missions', 'coins', 'early_signal', 'health_status', 'health_tree', 'feed', 'daily_gift', 'gift_history', 'call_settings', 'voice_settings', 'app_permissions', 'my_qr', 'subscription', 'subscription_plans', 'wallet', 'terms', 'privacy_policy', 'medical_sources',
]), evidence }).strict();
const profileSchema = z.object({ type: z.literal('profile'), changes: z.object({
  name: z.string().trim().min(1).max(100).optional(),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value && date <= new Date() && date.getUTCFullYear() >= 1900;
  }).optional(),
  gender: z.enum(['Nam', 'Nữ']).optional(), heightCm: z.number().min(50).max(250).optional(), bloodType: z.enum(['A', 'B', 'AB', 'O', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']).nullable().optional(),
  chronicDiseases: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
}).strict().refine(value => Object.keys(value).length > 0), evidence }).strict();
const reminderSchema = z.object({ type: z.literal('routine_reminders'), evidence }).strict();

async function query(db, userId, action, lang = 'vi') {
  const en = lang === 'en', tz = 'Asia/Ho_Chi_Minh';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map(part => [part.type, part.value]));
  const calendarDay = new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00Z`);
  const windows = { today: [0, 1], yesterday: [-1, 0], week: [-6, 1], month: [-29, 1],
    this_week: [-((calendarDay.getUTCDay() + 6) % 7), 1], this_month: [1 - calendarDay.getUTCDate(), 1] };
  let [start, end] = windows[action.range] || [0, 1];
  if (action.range === 'custom') {
    if (!action.startDate || !action.endDate || action.endDate < action.startDate || (Date.parse(action.endDate) - Date.parse(action.startDate)) / 86400000 > 365) throw Object.assign(new Error('Invalid dates'), { code: 'APP_ASSISTANT_INVALID_REQUEST' });
    start = Math.round((Date.parse(action.startDate) - calendarDay.getTime()) / 86400000);
    end = Math.round((Date.parse(action.endDate) - calendarDay.getTime()) / 86400000) + 1;
  }
  const params = [userId, start, end, tz];
  const bounds = `c.occurred_at >= (((now() AT TIME ZONE $4)::date + $2::int) AT TIME ZONE $4)
    AND c.occurred_at < (((now() AT TIME ZONE $4)::date + $3::int) AT TIME ZONE $4)`;
  const periods = en ? { today: 'Today', yesterday: 'Yesterday', week: 'Last 7 days', month: 'Last 30 days', this_week: 'This week', this_month: 'This month' }
    : { today: 'Hôm nay', yesterday: 'Hôm qua', week: '7 ngày gần đây', month: '30 ngày gần đây', this_week: 'Tuần này', this_month: 'Tháng này' };
  const period = action.range === 'custom' ? `${action.startDate} → ${action.endDate}` : periods[action.range];
  const localTime = date => new Intl.DateTimeFormat(en ? 'en-GB' : 'vi-VN', { timeZone: tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(date));
  if (action.topic === 'profile') {
    const profile = await profileContext(db, userId);
    return en ? `Name: ${profile.name}\nDate of birth: ${profile.dateOfBirth ? String(profile.dateOfBirth).slice(0, 10) : 'Not provided'}\nGender: ${profile.gender || 'Not provided'}\nHeight: ${profile.heightCm ?? 'Not provided'} cm\nBlood group: ${profile.bloodType || 'Not provided'}\nDeclared conditions: ${profile.chronicDiseases.join(', ') || 'None'}`
      : `Họ tên: ${profile.name}\nNgày sinh: ${profile.dateOfBirth ? String(profile.dateOfBirth).slice(0, 10) : 'Chưa cung cấp'}\nGiới tính: ${profile.gender || 'Chưa cung cấp'}\nChiều cao: ${profile.heightCm ?? 'Chưa cung cấp'} cm\nNhóm máu: ${profile.bloodType || 'Chưa cung cấp'}\nBệnh nền đã khai báo: ${profile.chronicDiseases.join(', ') || 'Không có'}`;
  }
  if (action.topic === 'reminders') {
    const p = await require('../notification/smart.schedule.service').getPreferences(db, userId, { refreshInferred: false });
    return en ? `Morning: ${p.effective_morning_time}\nAfternoon: ${p.effective_afternoon_time}\nEvening: ${p.effective_evening_time}\nTask reminders: ${p.reminders_enabled ? 'on' : 'off'}`
      : `Buổi sáng: ${p.effective_morning_time}\nBuổi trưa: ${p.effective_afternoon_time}\nBuổi tối: ${p.effective_evening_time}\nNhắc nhiệm vụ: ${p.reminders_enabled ? 'đang bật' : 'đang tắt'}`;
  }
  if (action.topic === 'meal') {
    const rows = (await db.query(`SELECT c.occurred_at,m.meal_text,m.calories_kcal FROM logs_common c JOIN meal_logs m ON m.log_id=c.id WHERE c.user_id=$1 AND c.log_type='meal' AND ${bounds} ORDER BY c.occurred_at DESC LIMIT 20`, params)).rows;
    return rows.length ? `${period}:\n${rows.map(row => `${localTime(row.occurred_at)}: ${row.meal_text}${row.calories_kcal == null ? '' : ` · ${row.calories_kcal} kcal`}`).join('\n')}` : en ? `${period}: no meal entries.` : `${period}, bạn chưa có lần ghi bữa ăn nào.`;
  }
  if (action.topic === 'water') {
    const row = (await db.query(`SELECT count(*)::int count,COALESCE(sum(d.volume_ml),0)::float total
      FROM logs_common c JOIN water_logs d ON d.log_id=c.id WHERE c.user_id=$1 AND c.log_type='water' AND ${bounds}`, params)).rows[0];
    return Number(row.count) ? en ? `${period}: you logged ${row.total} ml of water in ${row.count} entries.`
      : `${period}, bạn đã ghi ${row.total} ml nước trong ${row.count} lần.`
      : en ? `${period}: no water entries yet.` : `${period}, bạn chưa có lần ghi nước uống nào.`;
  }
  if (['blood_pressure', 'glucose'].includes(action.topic)) {
    const bp = action.topic === 'blood_pressure';
    const table = bp ? 'blood_pressure_logs' : 'glucose_logs';
    if (action.statistic === 'average' || (!bp && ['min', 'max'].includes(action.statistic))) {
      const fn = { average: 'avg', min: 'min', max: 'max' }[action.statistic];
      const aggregate = bp ? `round(avg(d.systolic)::numeric,1) systolic,round(avg(d.diastolic)::numeric,1) diastolic`
        : `round(${fn}(d.value)::numeric,1) value,COALESCE(d.unit,'mg/dL') unit`;
      const rows = (await db.query(`SELECT count(*)::int count,${aggregate} FROM logs_common c JOIN ${table} d ON d.log_id=c.id
        WHERE c.user_id=$1 AND c.log_type='${bp ? 'bp' : 'glucose'}' AND ${bounds} ${bp ? '' : "GROUP BY COALESCE(d.unit,'mg/dL')"}`, params)).rows.filter(row => row.count > 0);
      if (!rows.length) return en ? `${period}: no readings yet.` : `${period}, bạn chưa có số đo nào.`;
      const label = en ? { average: 'Average', min: 'Lowest', max: 'Highest' }[action.statistic]
        : { average: 'Trung bình', min: 'Thấp nhất', max: 'Cao nhất' }[action.statistic];
      return `${period}, ${label}: ${rows.map(row => `${bp ? `${row.systolic}/${row.diastolic} mmHg` : `${row.value} ${row.unit}`} (${row.count} ${en ? 'readings' : 'lần đo'})`).join('; ')}.`;
    }
    const fields = bp ? 'd.systolic,d.diastolic,d.pulse' : 'd.value,d.unit,d.context';
    const order = bp && ['min', 'max'].includes(action.statistic) ? `d.systolic ${action.statistic === 'max' ? 'DESC' : 'ASC'},d.diastolic ${action.statistic === 'max' ? 'DESC' : 'ASC'}` : 'c.occurred_at DESC';
    const limit = action.statistic && action.statistic !== 'list' ? 1 : 15;
    const rows = (await db.query(`SELECT c.occurred_at,${fields},count(*) OVER()::int total
      FROM logs_common c JOIN ${table} d ON d.log_id=c.id
      WHERE c.user_id=$1 AND c.log_type='${bp ? 'bp' : 'glucose'}' AND ${bounds}
      ORDER BY ${order} LIMIT ${limit}`, params)).rows;
    if (!rows.length) return en ? `${period}: no ${bp ? 'blood pressure' : 'glucose'} entries yet.`
      : `${period}, bạn chưa có số đo ${bp ? 'huyết áp' : 'đường huyết'} nào.`;
    const selected = action.statistic === 'max' ? en ? 'Highest systolic reading:' : 'Số đo có huyết áp tâm thu cao nhất:'
      : action.statistic === 'min' ? en ? 'Lowest systolic reading:' : 'Số đo có huyết áp tâm thu thấp nhất:'
      : en ? 'Latest readings:' : 'Các số đo gần nhất:';
    const heading = en ? `${period}: ${rows[0].total} entries. ${selected}`
      : `${period}, có ${rows[0].total} lần đo. ${selected}`;
    return `${heading}\n${rows.map(row => `${localTime(row.occurred_at)}: ${bp ? `${row.systolic}/${row.diastolic} mmHg${row.pulse ? `, ${row.pulse} ${en ? 'bpm' : 'nhịp/phút'}` : ''}` : `${row.value} ${row.unit || 'mg/dL'}`}`).join('\n')}`;
  }
  if (action.topic === 'medication') {
    const med = require('./medication-assistant.service');
    const context = await med.contextForPlan(db, userId);
    if (!context.available) return en ? 'Medication reminders are not enabled for this account.' : 'Tài khoản này chưa bật tính năng nhắc thuốc.';
    if (!context.schedules.length) return en ? 'You have no medication reminders yet.' : 'Bạn chưa có lịch nhắc thuốc nào.';
    return (en ? 'Your medication reminders:\n' : 'Lịch nhắc thuốc của bạn:\n') + context.schedules.map(row =>
      `${row.time}: ${row.item_ids.map(id => context.items.find(item => item.id === id)?.name).filter(Boolean).join(', ')}${row.active === false ? en ? ' (paused)' : ' (tạm dừng)' : ''}`
    ).join('\n');
  }
  const rows = (await db.query(`SELECT current_status AS status,created_at FROM health_checkins WHERE user_id=$1
    AND created_at >= (((now() AT TIME ZONE $4)::date + $2::int) AT TIME ZONE $4)
    AND created_at < (((now() AT TIME ZONE $4)::date + $3::int) AT TIME ZONE $4)
    ORDER BY created_at DESC LIMIT 15`, params)).rows;
  const labels = en ? { fine: 'Feeling well', tired: 'Feeling tired', very_tired: 'Feeling very tired' }
    : { fine: 'Ổn', tired: 'Hơi mệt', very_tired: 'Rất mệt' };
  return rows.length ? `${period}:\n${rows.map(row => `${localTime(row.created_at)}: ${labels[row.status] || (en ? 'Check-in recorded' : 'Đã ghi nhận check-in')}`).join('\n')}`
    : en ? `${period}: no check-in records yet.` : `${period}, bạn chưa có lần check-in nào.`;
}

async function prepareReminders(pool, userId, action, lang, { signal } = {}) {
  const plan = await reminders.plan(pool, userId, action.evidence, lang, { readOnly: true, signal });
  return plan.status === 'ready' ? { type: 'routine_reminders', planToken: plan.planToken, changes: plan.changes }
    : { status: 'clarify', question: plan.question || (lang === 'en' ? 'Those reminder times are already set.' : 'Các giờ nhắc này đã được đặt rồi nhé.') };
}

async function profileContext(db, userId) {
  if (!db || !userId) return null;
  return require('./profile-assistant.service').read(db, userId);
}

module.exports = { querySchema, navigateSchema, profileSchema, reminderSchema, query, prepareReminders, profileContext };
