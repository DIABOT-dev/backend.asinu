'use strict';

// Authorized operations lookup. Read-only; omit tokens, answers and conclusion
// text. Inspect interview metadata only for the explicitly requested phone.
const normalizeName = (value) =>
  String(value || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
const accents = 'áàảãạăắằẳẵặâấầẩẫậéèẻẽẹêếềểễệíìỉĩịóòỏõọôốồổỗộơớờởỡợúùủũụưứừửữựýỳỷỹỵđ';

function lookupQuery(input) {
  const name = String(input.name || '').trim(),
    phone = String(input.phone || '').replace(/\D/g, '');
  if (name.length > 120 || (phone && !/^\d{9,15}$/.test(phone)) || (!name && !phone))
    throw new Error('INVALID_LOOKUP');
  const words = normalizeName(name).split(/\s+/).filter(Boolean);
  if (words.length > 8 || (name && !words.length)) throw new Error('INVALID_LOOKUP');
  const values = words.length ? [accents, normalizeName(accents).replace(/ /g, '')] : [];
  const expression =
    "regexp_replace(translate(lower(concat_ws(' ',u.full_name,u.display_name)),$1,$2),'[̀-ͯ]','','g')";
  const conditions = [];
  if (words.length)
    conditions.push(
      '(' +
        words
          .map((word) => {
            values.push('%' + word + '%');
            return expression + ' LIKE $' + values.length;
          })
          .join(' AND ') +
        ')'
    );
  if (phone) {
    values.push('%' + phone.slice(-9));
    conditions.push("regexp_replace(u.phone_number,'[^0-9]','','g') LIKE $" + values.length);
  }
  return {
    phoneSuffix: phone.slice(-9),
    sql: `SELECT u.id,u.full_name,u.display_name,
    RIGHT(regexp_replace(u.phone_number,'[^0-9]','','g'),4) phone_last4,
    u.created_at,u.deleted_at IS NOT NULL AS deleted,
    ${phone ? "regexp_replace(u.phone_number,'[^0-9]','','g') LIKE $" + values.length : 'false'} AS phone_match
    FROM users u WHERE ${conditions.join(' OR ')} ORDER BY u.id LIMIT 20`,
    values,
  };
}

async function audit(client, input) {
  const query = lookupQuery(input);
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client.query("SET LOCAL statement_timeout='10s'");
    const users = (await client.query(query.sql, query.values)).rows;
    const logins = (
      await client.query(
        `SELECT DISTINCT ON (payload->>'user_id') payload->>'user_id' AS user_id,
          occurred_at AS last_login_at, payload->>'source_platform' AS login_provider
        FROM crm_event_outbox WHERE event_type='session.started'
          AND payload->>'user_id'=ANY($1::text[])
        ORDER BY payload->>'user_id',occurred_at DESC,id DESC`,
        [users.map((user) => String(user.id))]
      )
    ).rows;
    const latestLogin =
      (
        await client.query(
          `SELECT u.id,u.full_name,u.display_name,
          RIGHT(regexp_replace(u.phone_number,'[^0-9]','','g'),4) AS phone_last4,
          e.occurred_at AS last_login_at,e.payload->>'source_platform' AS login_provider
        FROM crm_event_outbox e JOIN users u ON u.id::text=e.payload->>'user_id'
        WHERE e.event_type='session.started' AND u.deleted_at IS NULL
        ORDER BY e.occurred_at DESC,e.id DESC LIMIT 1`
        )
      ).rows[0] || null;
    const output = {
      users: users.map((user) => ({
        ...user,
        ...logins.find((login) => login.user_id === String(user.id)),
      })),
      latest_login: latestLogin,
      interviews: [],
    };
    for (const user of users.filter((user) => user.phone_match)) {
      const sessions = (
        await client.query(
          `SELECT id,session_date,triage_state,triage_messages,
        triage_completed_at FROM health_checkins WHERE user_id=$1 ORDER BY session_date DESC LIMIT 3`,
          [user.id]
        )
      ).rows;
      for (const session of sessions) {
        const answers = session.triage_messages || [],
          steps = answers.map((answer) => answer.step || 'legacy-unlabelled');
        const counts = new Map();
        for (const [index, answer] of answers.entries()) {
          const key = String(answer.question || '')
            .trim()
            .toLowerCase();
          if (!key) continue;
          const group = counts.get(key) || { step: answer.step || null, positions: [] };
          group.positions.push(index + 1);
          counts.set(key, group);
        }
        const result = session.triage_state?.completed?.result || {};
        output.interviews.push({
          user_id: user.id,
          id: session.id,
          date: session.session_date,
          answer_count: answers.length,
          steps,
          repeated_questions: [...counts.values()].filter((item) => item.positions.length > 1),
          assessment_version: session.triage_state?.assessment_version || null,
          phase: session.triage_state?.phase || null,
          completed_at: session.triage_completed_at,
          result_version: result.conclusionVersion || null,
          result_format: result.conclusionFormat || null,
          result_source: result.conclusionSource || null,
          summary_chars: String(result.summary || '').length,
          narrative_chars: String(result.narrative || '').length,
        });
      }
    }
    return output;
  } finally {
    await client.query('ROLLBACK');
  }
}

async function main() {
  const input = JSON.parse(Buffer.from(process.argv[2] || '', 'base64').toString('utf8'));
  lookupQuery(input);
  const { Client } = require('pg');
  const { databaseOptions } = require(
    require('node:path').join(process.cwd(), 'src/lib/database-options')
  );
  const client = new Client(databaseOptions(process.env.DATABASE_URL));
  await client.connect();
  try {
    console.log('CHECKIN_PREVIEW_AUDIT_BEGIN');
    console.log(JSON.stringify(await audit(client, input), null, 2));
    console.log('CHECKIN_PREVIEW_AUDIT_END');
  } finally {
    await client.end();
  }
}
if (!module.parent)
  main().catch((error) => {
    console.error('Read-only check-in audit failed:', error.code || error.name);
    process.exitCode = 1;
  });
module.exports = { normalizeName, lookupQuery, audit };
