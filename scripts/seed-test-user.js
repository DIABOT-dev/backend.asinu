/**
 * Seed data cho user test (ID 14 - ducytcg123@gmail.com)
 * Chạy: node scripts/seed-test-user.js
 */
require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const USER_ID = 14;

async function seed() {
  console.log('Seeding data for user', USER_ID, '...');

  // 1. Onboarding profile
  await pool.query(`
    INSERT INTO user_onboarding_profiles (user_id, birth_year, gender, medical_conditions, daily_medication, height_cm, weight_kg, goal, body_type, exercise_freq, sleep_duration, water_intake, full_name)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    ON CONFLICT (user_id) DO UPDATE SET
      birth_year=$2, gender=$3, medical_conditions=$4, daily_medication=$5,
      height_cm=$6, weight_kg=$7, goal=$8, full_name=$13
  `, [
    USER_ID, 1958, 'Nam',
    JSON.stringify(['Tiểu đường', 'Cao huyết áp', 'Tim mạch']),
    'Có', 165, 68, 'Kiểm soát đường huyết',
    'Trung bình', '2-3 lần/tuần', '6-7 tiếng', '4-5 ly/ngày',
    'Trần Văn Hùng'
  ]);
  console.log('  OK: profile');

  // 2. Update users table
  await pool.query(`
    UPDATE users SET full_name=$1, display_name=$2 WHERE id=$3
  `, ['Trần Văn Hùng', 'Chú Hùng', USER_ID]).catch(() => {});
  console.log('  OK: user name');

  // 3. Health check-ins (7 ngày)
  const checkins = [
    { days: 6, status: 'tired',      summary: 'mệt mỏi, chóng mặt từ sáng',           sev: 'medium' },
    { days: 5, status: 'fine',        summary: 'khoẻ, không vấn đề',                     sev: 'low' },
    { days: 4, status: 'very_tired',  summary: 'rất mệt, đau đầu, hoa mắt',             sev: 'high' },
    { days: 3, status: 'tired',       summary: 'hơi mệt, buồn ngủ sau ăn trưa',         sev: 'medium' },
    { days: 2, status: 'fine',        summary: 'ổn định, đường huyết giảm',              sev: 'low' },
    { days: 1, status: 'tired',       summary: 'mệt nhẹ, tê bì tay chân buổi sáng',    sev: 'medium' },
    { days: 0, status: 'fine',        summary: 'khoẻ hơn hôm qua',                       sev: 'low' },
  ];
  for (const c of checkins) {
    const d = new Date(); d.setDate(d.getDate() - c.days);
    const ds = d.toISOString().slice(0, 10);
    await pool.query(`
      INSERT INTO health_checkins (user_id, session_date, initial_status, current_status, flow_state, triage_summary, triage_severity, resolved_at, last_response_at)
      VALUES ($1, $2, $3, 'fine', 'resolved', $4, $5, NOW(), NOW())
      ON CONFLICT (user_id, session_date) DO NOTHING
    `, [USER_ID, ds, c.status, c.summary, c.sev]);
  }
  console.log('  OK: 7 check-ins');

  // 4. Glucose logs
  const glucoseVals = [210, 178, 225, 195, 185, 168, 190];
  for (let i = 0; i < glucoseVals.length; i++) {
    const d = new Date(); d.setDate(d.getDate() - (6 - i));
    try {
      const r = await pool.query(
        `INSERT INTO logs_common (user_id, log_type, occurred_at, created_at) VALUES ($1, 'glucose', $2, $2) RETURNING id`,
        [USER_ID, d.toISOString()]
      );
      await pool.query(
        `INSERT INTO log_glucose (log_id, value, unit, context) VALUES ($1, $2, 'mg/dL', 'trước ăn')`,
        [r.rows[0].id, glucoseVals[i]]
      );
    } catch {}
  }
  console.log('  OK: 7 glucose logs');

  // 5. BP logs
  const bpVals = [[155,95,82],[142,88,76],[160,98,85],[148,92,78],[145,90,78],[150,93,80],[138,86,74]];
  for (let i = 0; i < bpVals.length; i++) {
    const d = new Date(); d.setDate(d.getDate() - (6 - i));
    try {
      const r = await pool.query(
        `INSERT INTO logs_common (user_id, log_type, occurred_at, created_at) VALUES ($1, 'blood_pressure', $2, $2) RETURNING id`,
        [USER_ID, d.toISOString()]
      );
      await pool.query(
        `INSERT INTO log_blood_pressure (log_id, systolic, diastolic, pulse) VALUES ($1, $2, $3, $4)`,
        [r.rows[0].id, bpVals[i][0], bpVals[i][1], bpVals[i][2]]
      );
    } catch {}
  }
  console.log('  OK: 7 BP logs');

  // 6. User memories
  const memories = [
    ['hay bị chóng mặt buổi sáng, đặc biệt khi đứng dậy nhanh', 'health'],
    ['thường quên uống thuốc buổi tối', 'medication'],
    ['thích ăn cá, không thích thịt bò', 'preference'],
    ['lo lắng về biến chứng tiểu đường ảnh hưởng mắt', 'concern'],
    ['hay đi bộ buổi chiều 30 phút quanh công viên', 'habit'],
    ['đường huyết thường tăng cao sau bữa trưa', 'health'],
    ['ngủ không sâu, hay thức giữa đêm 2-3h sáng', 'health'],
  ];
  for (const [content, category] of memories) {
    await pool.query(
      `INSERT INTO user_memories (user_id, content, category) VALUES ($1, $2, $3)`,
      [USER_ID, content, category]
    );
  }
  console.log('  OK: 7 memories');

  // 7. Chat history
  const chats = [
    ['user', 'Tôi bị chóng mặt mấy hôm nay'],
    ['assistant', 'Chú ơi, cháu nghe chú nói mà lo quá. Chóng mặt mấy hôm liền thì mình cần để ý. Chú có đo huyết áp chưa? Với đường huyết nữa, hai cái này hay gây chóng mặt lắm.'],
    ['user', 'Huyết áp 148/92, đường huyết 195'],
    ['assistant', 'Huyết áp 148/92 hơi cao, đường huyết 195 cũng vượt ngưỡng rồi chú. Hai cái này kết hợp là nguyên nhân gây chóng mặt đó. Tối nay nhớ uống thuốc đúng giờ nha, rồi ngày mai đo lại cho cháu xem.'],
    ['user', 'Tôi hay quên uống thuốc buổi tối'],
    ['assistant', 'Cháu hiểu, nhiều người cũng hay quên buổi tối lắm chú. Chú thử đặt báo thức 8h tối trên điện thoại, mỗi lần chuông kêu là uống luôn. Đặt sẵn thuốc cạnh ly nước trên bàn ngủ cho tiện. Ngày mai chú báo cháu xem có nhớ uống không nha.'],
    ['user', 'Tôi lo về mắt, tiểu đường có ảnh hưởng mắt không?'],
    ['assistant', 'Chú lo đúng rồi. Tiểu đường lâu ngày có thể ảnh hưởng mạch máu nhỏ ở mắt, gọi là bệnh võng mạc tiểu đường. Nhưng nếu kiểm soát đường huyết tốt thì nguy cơ giảm rất nhiều. Chú nên đi khám mắt định kỳ 6 tháng/lần. Lần gần nhất chú khám mắt là khi nào?'],
  ];
  const baseTime = new Date();
  baseTime.setDate(baseTime.getDate() - 2);
  for (let i = 0; i < chats.length; i++) {
    const t = new Date(baseTime.getTime() + i * 60000); // cách nhau 1 phút
    await pool.query(
      `INSERT INTO chat_histories (user_id, message, sender, created_at) VALUES ($1, $2, $3, $4)`,
      [USER_ID, chats[i][1], chats[i][0], t.toISOString()]
    );
  }
  console.log('  OK: 8 chat messages');

  console.log('\nDone! User', USER_ID, 'now has full test data.');
  await pool.end();
}

seed().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
