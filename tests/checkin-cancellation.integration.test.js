'use strict';
const fs = require('node:fs');
const { Pool } = require('pg');
const { randomUUID } = require('node:crypto');
jest.mock('../src/lib/redis', () => ({ cacheDel: jest.fn(async () => {}) }));
jest.mock('../src/services/health/health-timeline.service', () => ({
  rebuildPatientHealthTimeline: jest.fn(async () => {}),
}));
// The state/SQL tests use an opaque in-memory vault adapter. Cryptography is
// covered by the separate health-field/keyring suites without touching live keys.
jest.mock('../src/security/health-field-encryption', () => {
  const records = new Map();
  let sequence = 0;
  return {
    encryptHealthField: (user, field, value) => {
      const token = `opaque-checkpoint-${++sequence}`;
      records.set(token, { user: String(user), field, value });
      return token;
    },
    decryptHealthField: (user, field, token) => {
      const item = records.get(token);
      if (!item || item.user !== String(user) || item.field !== field)
        throw new Error('Invalid owner');
      return item.value;
    },
  };
});
const {
  cancelCheckin,
  createCancelCheckpoint,
  publicCheckinSession,
  phaseIdOf,
} = require('../src/services/checkin/checkin-cancellation.service');
const enabled = process.env.CHECKIN_TEST_DATABASE_URL ? describe : describe.skip;
enabled('check-in cancellation with PostgreSQL row locks', () => {
  const schema = `qa_cancel_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: process.env.CHECKIN_TEST_DATABASE_URL });
  const pool = new Pool({
    connectionString: process.env.CHECKIN_TEST_DATABASE_URL,
    options: `-c search_path=${schema},public`,
  });
  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await pool.query('CREATE TABLE users(id INTEGER PRIMARY KEY)');
    await pool.query('INSERT INTO users VALUES(7),(8)');
    await pool.query(
      'CREATE TABLE health_checkins (LIKE public.health_checkins INCLUDING DEFAULTS INCLUDING CONSTRAINTS)'
    );
    await pool.query(
      'CREATE TABLE health_checkin_occurrences (LIKE public.health_checkin_occurrences INCLUDING DEFAULTS INCLUDING CONSTRAINTS)'
    );
    await pool.query(
      fs.readFileSync('db/migrations/130_checkin_cancellation_receipts.sql', 'utf8')
    );
  });
  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });
  beforeEach(async () => {
    await pool.query(
      'TRUNCATE health_checkins, health_checkin_occurrences, health_checkin_cancellations'
    );
  });
  async function seed(state = {}, overrides = {}) {
    const data = {
      id: '100',
      user_id: 7,
      initial_status: 'tired',
      current_status: 'tired',
      flow_state: 'follow_up',
      session_date: '2026-11-09',
      triage_messages: [
        { step: 'symptoms', question: 'Synthetic question', answer: 'Synthetic answer' },
      ],
      triage_state: {
        phase: 'initial',
        phase_id: 'phase-current',
        revision: 'revision-current',
        ...state,
      },
      ...overrides,
    };
    const columns = Object.keys(data);
    await pool.query(
      `INSERT INTO health_checkins(${columns.join(',')}) VALUES(${columns.map((field, index) => `$${index + 1}${['triage_state', 'triage_messages'].includes(field) ? '::jsonb' : ''}`).join(',')})`,
      columns.map((field) =>
        ['triage_state', 'triage_messages'].includes(field)
          ? JSON.stringify(data[field])
          : data[field]
      )
    );
    return (await pool.query('SELECT * FROM health_checkins WHERE id=$1', [data.id])).rows[0];
  }
  test('cancels only the requested first interview and leaves other days untouched', async () => {
    await seed();
    await seed({}, { id: '101', session_date: '2026-11-08' });
    expect(await cancelCheckin(pool, 7, '100', 'phase-current')).toMatchObject({
      cancelled: true,
      restoredPrevious: false,
    });
    expect((await pool.query('SELECT id FROM health_checkins')).rows.map((row) => row.id)).toEqual([
      '101',
    ]);
    expect((await pool.query('SELECT * FROM health_checkin_cancellations')).rowCount).toBe(1);
  });
  test('concurrent taps and a lost-response retry produce one cancellation receipt', async () => {
    await seed();
    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () => cancelCheckin(pool, 7, '100', 'phase-current'))
    );
    expect(outcomes.every((result) => result.cancelled)).toBe(true);
    expect((await pool.query('SELECT * FROM health_checkin_cancellations')).rowCount).toBe(1);
    expect((await cancelCheckin(pool, 7, '100', 'phase-current')).alreadyCancelled).toBe(true);
  });
  test('rejects another patient or stale phase without changing any answers', async () => {
    const original = await seed();
    await expect(cancelCheckin(pool, 8, '100', 'phase-current')).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND',
    });
    await expect(cancelCheckin(pool, 7, '100', 'old-phase')).rejects.toMatchObject({
      code: 'TRIAGE_CHANGED',
    });
    expect(
      (await pool.query('SELECT triage_messages FROM health_checkins WHERE id=100')).rows[0]
        .triage_messages
    ).toEqual(original.triage_messages);
  });
  test('a conclusion already committed cannot be cancelled', async () => {
    await seed({ completed: { finalized: true } }, { triage_completed_at: new Date() });
    await expect(cancelCheckin(pool, 7, '100', 'phase-current')).rejects.toMatchObject({
      code: 'CHECKIN_ALREADY_COMPLETED',
    });
    expect((await pool.query('SELECT * FROM health_checkins')).rowCount).toBe(1);
  });
  test('a committed conclusion awaiting notification finalization cannot be cancelled', async () => {
    await seed(
      { completed: { finalized: false, committed: true } },
      {
        triage_completed_at: new Date(),
      }
    );
    await expect(cancelCheckin(pool, 7, '100', 'phase-current')).rejects.toMatchObject({
      code: 'CHECKIN_ALREADY_COMPLETED',
    });
    expect((await pool.query('SELECT * FROM health_checkin_cancellations')).rowCount).toBe(0);
  });
  test('a conclusion still computing can be cancelled before committing any result', async () => {
    await seed({ completed: { finalized: false } });
    expect(await cancelCheckin(pool, 7, '100', 'phase-current')).toMatchObject({ cancelled: true });
    expect((await pool.query('SELECT * FROM health_checkins')).rowCount).toBe(0);
  });
  test('restores the exact prior completed interview, including its next reminder and conclusion cache', async () => {
    const previous = await seed(
      {
        phase_id: 'previous',
        completed: { finalized: true, result: { isDone: true, summary: 'Synthetic prior result' } },
      },
      {
        current_status: 'fine',
        initial_status: 'fine',
        flow_state: 'monitoring',
        triage_completed_at: new Date('2026-11-09T00:00:00Z'),
        next_checkin_at: new Date('2026-11-09T14:00:00Z'),
        triage_summary: 'Synthetic prior result',
      }
    );
    const checkpoint = createCancelCheckpoint(previous);
    expect(checkpoint).not.toContain('Synthetic');
    await pool.query(
      'UPDATE health_checkins SET current_status=$1, initial_status=$1,triage_state=$2::jsonb,triage_completed_at=NULL WHERE id=100',
      [
        'tired',
        JSON.stringify({
          phase: 'initial',
          phase_id: 'new-phase',
          revision: 'new-write',
          cancel_checkpoint: checkpoint,
        }),
      ]
    );
    expect((await cancelCheckin(pool, 7, '100', 'new-phase')).restoredPrevious).toBe(true);
    const restored = (await pool.query('SELECT * FROM health_checkins WHERE id=100')).rows[0];
    for (const field of [
      'initial_status',
      'current_status',
      'triage_state',
      'triage_messages',
      'triage_summary',
      'triage_completed_at',
      'next_checkin_at',
    ])
      expect(restored[field]).toEqual(previous[field]);
    expect((await cancelCheckin(pool, 7, '100', 'new-phase')).alreadyCancelled).toBe(true);
    expect(
      (await pool.query('SELECT triage_state FROM health_checkins WHERE id=100')).rows[0]
        .triage_state.phase_id
    ).toBe('previous');
  });
  test('a response computed before cancellation cannot save via the existing CAS guard', async () => {
    const old = await seed();
    await cancelCheckin(pool, 7, '100', 'phase-current');
    const stale = await pool.query(
      'UPDATE health_checkins SET triage_messages=$1::jsonb WHERE id=$2 AND triage_state=$3::jsonb RETURNING id',
      [
        JSON.stringify([{ step: 'onset', answer: 'Synthetic late answer' }]),
        old.id,
        JSON.stringify(old.triage_state),
      ]
    );
    expect(stale.rowCount).toBe(0);
  });
  test('legacy occurrence history is retained when cancelling its current replacement', async () => {
    await seed();
    await pool.query(`INSERT INTO health_checkin_occurrences(id,checkin_id,user_id,session_date,source,initial_status,current_status,flow_state,triage_messages,triage_summary,started_at,completed_at,snapshot_updated_at)
      VALUES(1,100,7,'2026-11-09','scheduled','fine','fine','monitoring','[]'::jsonb,'Synthetic archived result',NOW()-INTERVAL '2 hours',NOW()-INTERVAL '1 hour',NOW()-INTERVAL '1 hour')`);
    expect((await cancelCheckin(pool, 7, '100', 'phase-current')).restoredPrevious).toBe(true);
    expect((await pool.query('SELECT * FROM health_checkin_occurrences')).rowCount).toBe(1);
    expect(
      (await pool.query('SELECT triage_summary FROM health_checkins WHERE id=100')).rows[0]
        .triage_summary
    ).toBe('Synthetic archived result');
  });
  test('checkpoints remain server-private and are bound to patient/phase identity', async () => {
    const row = await seed();
    const checkpoint = createCancelCheckpoint(row);
    expect(phaseIdOf(row)).toBe('phase-current');
    const visible = publicCheckinSession({
      ...row,
      triage_state: {
        ...row.triage_state,
        cancel_checkpoint: checkpoint,
        adaptive_payload: 'private',
      },
    });
    expect(visible.triage_state).not.toHaveProperty('cancel_checkpoint');
    expect(visible.triage_state).not.toHaveProperty('adaptive_payload');
    expect(row.triage_state.phase_id).toBe('phase-current');
  });
});
