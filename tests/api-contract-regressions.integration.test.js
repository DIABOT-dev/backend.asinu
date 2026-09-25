const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

process.env.JWT_SECRET ||= 'api-contract-regression-test-secret';

const checkinService = require('../src/services/checkin/checkin.service');
const careCircleService = require('../src/services/care-circle/careCircle.service');
const profileService = require('../src/services/profile/profile.service');
const healthAlertService = require('../src/services/health/health-alert.service');
const wellnessController = require('../src/controllers/wellness.controller');
const authService = require('../src/services/auth/auth.service');

const testDatabaseUrl =
  process.env.CHECKIN_TEST_DATABASE_URL ||
  (process.env.RUN_DB_REGRESSION_TESTS === '1' ? process.env.DATABASE_URL : null);
const describeDatabase = testDatabaseUrl ? describe : describe.skip;

describeDatabase('API contract regressions', () => {
  const pool = new Pool({ connectionString: testDatabaseUrl });
  const userIds = [];

  async function createUser(label) {
    const result = await pool.query(
      'INSERT INTO users (phone_number, display_name) VALUES ($1,$2) RETURNING id',
      [`ct${Date.now()}${Math.floor(Math.random() * 100000)}`, `Contract ${label}`]
    );
    const id = result.rows[0].id;
    userIds.push(id);
    return id;
  }

  async function connectUsers(patientId, caregiverId) {
    const result = await pool.query(
      `INSERT INTO user_connections
         (requester_id, addressee_id, requested_by, status, permissions, accepted_at)
       VALUES ($1,$2,$1,'accepted',$3::jsonb,now())
       RETURNING id`,
      [
        patientId,
        caregiverId,
        JSON.stringify({ can_receive_alerts: true, can_ack_escalation: true }),
      ]
    );
    return result.rows[0].id;
  }

  afterAll(async () => {
    if (userIds.length) {
      await pool.query('DELETE FROM user_engagement WHERE user_id = ANY($1::integer[])', [userIds]);
      await pool.query('DELETE FROM mission_history WHERE user_id = ANY($1::integer[])', [userIds]);
      await pool.query('DELETE FROM user_missions WHERE user_id = ANY($1::integer[])', [userIds]);
      await pool.query(
        'DELETE FROM caregiver_alerts WHERE user_id = ANY($1::integer[]) OR caregiver_user_id = ANY($1::integer[])',
        [userIds]
      );
      await pool.query(
        'DELETE FROM user_connections WHERE requester_id = ANY($1::integer[]) OR addressee_id = ANY($1::integer[])',
        [userIds]
      );
      await pool.query('DELETE FROM users WHERE id = ANY($1::integer[])', [userIds]);
    }
    await pool.end();
  });

  test('manual check-in cancels an active call, attempts, and deliveries', async () => {
    const userId = await createUser('manual-checkin');
    const episode = await pool.query(
      `INSERT INTO checkin_call_episodes
         (user_id, local_date, state, severity, scheduled_at, grace_until, next_action_at, config)
       VALUES ($1, DATE '2099-01-01', 'CONTACT_USER', 'NONE', now(), now(), now(), '{}'::jsonb)
       RETURNING id`,
      [userId]
    );
    const attempt = await pool.query(
      `INSERT INTO checkin_call_attempts
         (episode_id, target_user_id, target_role, room_name, ring_deadline)
       VALUES ($1,$2,'USER',$3,now() + interval '1 minute') RETURNING id`,
      [episode.rows[0].id, userId, `contract-room-${Date.now()}`]
    );
    await pool.query(
      `INSERT INTO checkin_call_deliveries
         (episode_id, attempt_id, target_user_id, kind)
       VALUES ($1,$2,$3,'INCOMING_CALL')`,
      [episode.rows[0].id, attempt.rows[0].id, userId]
    );

    await checkinService.startCheckin(pool, userId, 'fine');

    const state = await pool.query(
      `SELECT e.state AS episode_state, a.state AS attempt_state, d.state AS delivery_state
       FROM checkin_call_episodes e
       JOIN checkin_call_attempts a ON a.episode_id=e.id
       JOIN checkin_call_deliveries d ON d.attempt_id=a.id
       WHERE e.id=$1`,
      [episode.rows[0].id]
    );
    expect(state.rows[0]).toEqual({
      episode_state: 'CANCELLED',
      attempt_state: 'CANCELLED',
      delivery_state: 'CANCELLED',
    });
  });

  test('seen records a view but only a committed caregiver action confirms', async () => {
    const patientId = await createUser('seen-patient');
    const caregiverId = await createUser('seen-caregiver');
    await connectUsers(patientId, caregiverId);
    const checkin = await checkinService.startCheckin(pool, patientId, 'tired');
    const alert = await pool.query(
      `INSERT INTO caregiver_alert_confirmations (checkin_id, caregiver_id, patient_id)
       VALUES ($1,$2,$3) RETURNING id`,
      [checkin.id, caregiverId, patientId]
    );

    const viewed = await checkinService.confirmCaregiverAlert(
      pool,
      caregiverId,
      alert.rows[0].id,
      'seen'
    );
    expect(viewed).toMatchObject({ ok: true, confirmed: false });
    let row = await pool.query(
      'SELECT seen_at, confirmed_at, confirmed_action FROM caregiver_alert_confirmations WHERE id=$1',
      [alert.rows[0].id]
    );
    expect(row.rows[0].seen_at).not.toBeNull();
    expect(row.rows[0].confirmed_at).toBeNull();

    let pending = await checkinService.getPendingCaregiverAlerts(pool, caregiverId);
    expect(pending).toHaveLength(0);
    await pool.query(
      "UPDATE caregiver_alert_confirmations SET resent_at=seen_at + interval '1 second' WHERE id=$1",
      [alert.rows[0].id]
    );
    pending = await checkinService.getPendingCaregiverAlerts(pool, caregiverId);
    expect(pending.map((item) => String(item.alertId))).toContain(String(alert.rows[0].id));

    await checkinService.confirmCaregiverAlert(pool, caregiverId, alert.rows[0].id, 'on_my_way');
    row = await pool.query(
      'SELECT confirmed_at, confirmed_action FROM caregiver_alert_confirmations WHERE id=$1',
      [alert.rows[0].id]
    );
    expect(row.rows[0].confirmed_at).not.toBeNull();
    expect(row.rows[0].confirmed_action).toBe('on_my_way');
  });

  test('health alert insertion matches the notifications schema', async () => {
    const patientId = await createUser('health-patient');
    const caregiverId = await createUser('health-caregiver');
    await connectUsers(patientId, caregiverId);
    const connections = await healthAlertService.getActiveConnections(pool, patientId);

    const inserted = await healthAlertService.insertAlertNotifications(pool, connections, {
      type: 'health_alert',
      title: 'Test alert',
      message: 'Please check',
      data: { severity: 'warning' },
    });

    expect(inserted).toBe(1);
    const saved = await pool.query(
      "SELECT message FROM notifications WHERE user_id=$1 AND type='health_alert' ORDER BY id DESC LIMIT 1",
      [caregiverId]
    );
    expect(saved.rows[0].message).toBe('Please check');
  });

  test('wellness UUID alert can be acknowledged after its connection is removed', async () => {
    const patientId = await createUser('alert-patient');
    const caregiverId = await createUser('alert-caregiver');
    const connectionId = await connectUsers(patientId, caregiverId);
    const alert = await pool.query(
      `INSERT INTO caregiver_alerts
         (user_id, caregiver_user_id, connection_id, alert_type, title, message)
       VALUES ($1,$2,$3,'INFO','Contract alert','Contract message') RETURNING id`,
      [patientId, caregiverId, connectionId]
    );

    const removed = await careCircleService.deleteConnection(pool, connectionId, patientId);
    expect(removed.ok).toBe(true);
    const preserved = await pool.query('SELECT connection_id FROM caregiver_alerts WHERE id=$1', [
      alert.rows[0].id,
    ]);
    expect(preserved.rows[0].connection_id).toBeNull();

    let statusCode;
    let responseBody;
    const req = {
      params: { id: alert.rows[0].id },
      user: { id: caregiverId },
      headers: { 'accept-language': 'vi' },
    };
    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(body) {
        responseBody = body;
        return this;
      },
    };
    await wellnessController.postAckAlert(pool, req, res);
    expect(statusCode).toBe(200);
    expect(responseBody).toMatchObject({ ok: true, alert: { id: alert.rows[0].id } });
  });

  test('account deletion handles engagement and legacy chat schema safely', async () => {
    const userId = await createUser('delete-account');
    await pool.query('INSERT INTO user_engagement (user_id,event_type) VALUES ($1,$2)', [
      userId,
      'contract_test',
    ]);

    const result = await profileService.deleteAccount(pool, userId);
    expect(result.ok).toBe(true);
    const remaining = await pool.query('SELECT 1 FROM users WHERE id=$1', [userId]);
    expect(remaining.rowCount).toBe(0);
  });

  test('email login returns the stored name and phone number', async () => {
    const userId = await createUser('email-login');
    const email = `contract-${Date.now()}@example.com`;
    const phone = `09${String(Date.now()).slice(-8)}`;
    const password = 'Contract123!';
    const passwordHash = await bcrypt.hash(password, 4);
    await pool.query(
      `UPDATE users
       SET email=$2, phone_number=$3, full_name='Nguyen Contract', password_hash=$4
       WHERE id=$1`,
      [userId, email, phone, passwordHash]
    );

    const result = await authService.loginByEmail(pool, email, password);
    expect(result).toMatchObject({
      ok: true,
      user: {
        id: userId,
        full_name: 'Nguyen Contract',
        phone_number: phone,
      },
    });
  });

  test('profile date of birth remains a date-only value', async () => {
    const userId = await createUser('date-of-birth');
    await pool.query(
      'INSERT INTO user_onboarding_profiles (user_id, date_of_birth) VALUES ($1,$2)',
      [userId, '1960-01-02']
    );

    const result = await profileService.getProfile(pool, userId);
    expect(result.profile.dateOfBirth).toBe('1960-01-02');
  });

  test('rejected invitation response does not report the deleted row as pending', async () => {
    const requesterId = await createUser('invite-requester');
    const addresseeId = await createUser('invite-addressee');
    const invitation = await pool.query(
      `INSERT INTO user_connections (requester_id, addressee_id, requested_by, status)
       VALUES ($1,$2,$1,'pending') RETURNING id`,
      [requesterId, addresseeId]
    );

    const result = await careCircleService.rejectInvitation(
      pool,
      invitation.rows[0].id,
      addresseeId
    );
    expect(result).toMatchObject({ ok: true, invitation: { status: 'rejected' } });
    const remaining = await pool.query('SELECT 1 FROM user_connections WHERE id=$1', [
      invitation.rows[0].id,
    ]);
    expect(remaining.rowCount).toBe(0);
  });
});
