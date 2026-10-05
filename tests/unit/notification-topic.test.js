'use strict';

const {
  buildNotificationTopics,
  consecutiveTiredDays,
  resolveSymptomLabel,
} = require('../../src/services/notification/notification-topic.service');
const intelligence = require('../../src/services/notification/notification-intelligence.service');
const reengagement = require('../../src/services/notification/reengagement.service');
const { t } = require('../../src/i18n');

const NOW = new Date('2026-10-05T07:00:00Z');
const user = { full_name: 'Dương Anh Đức', lang: 'vi' };
const symptom = (overrides = {}) => ({
  cluster_key: 'headache',
  display_name: 'Đau đầu',
  trend: 'stable',
  count_7d: 2,
  priority: 1,
  last_triggered_at: '2026-10-04T07:00:00Z',
  ...overrides,
});

function poolFor({
  medical = [],
  clusters = [],
  sessions = [],
  checkins = [],
  lifecycle = null,
  frequencies = [],
} = {}) {
  return {
    query: jest.fn(async (sql) => {
      if (sql.includes('FROM problem_clusters')) return { rows: clusters };
      if (sql.includes('FROM user_onboarding_profiles'))
        return { rows: [{ medical_conditions: medical }] };
      if (sql.includes('FROM symptom_frequency')) return { rows: frequencies };
      if (sql.includes('FROM script_sessions')) return { rows: sessions };
      if (sql.includes('FROM health_checkins')) return { rows: checkins };
      if (sql.includes('FROM user_lifecycle')) return { rows: lifecycle ? [lifecycle] : [] };
      if (sql.includes('FROM risk_persistence')) return { rows: [] };
      throw new Error('Unexpected notification query');
    }),
  };
}

describe('notification topics preserve the difference between diseases and symptoms', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test.each(['morning', 'afternoon', 'evening'])(
    '%s uses a dedicated diabetes monitoring message',
    async (trigger) => {
      const pool = poolFor({
        medical: ['Tiểu đường'],
        clusters: [symptom({ cluster_key: 'tiu_ng', display_name: 'Tiểu đường' })],
      });
      const message = await intelligence.generateMessage(pool, 42, trigger, user, {
        tasks: 'ghi chỉ số sức khỏe',
      });
      expect(message.templateId).toBe(`${trigger}_has_condition`);
      expect(message.text).toContain('theo dõi bệnh tiểu đường');
      expect(message.text).not.toMatch(/còn không|vẫn còn|còn kéo dài|đỡ hơn|nặng hơn/);
      expect(message.topic).toEqual({
        kind: 'medical_condition',
        code: 'diabetes',
        recordedAt: null,
      });
      expect(message.context.topSymptom).toBeNull();
      for (const [, params] of pool.query.mock.calls) expect(params).toEqual([42]);
    }
  );

  test.each([
    ['Tiểu đường', 'bệnh tiểu đường'],
    ['Tiền tiểu đường', 'tình trạng tiền tiểu đường'],
    ['Cao huyết áp', 'tình trạng tăng huyết áp'],
    ['Đau dạ dày', 'tình trạng đau dạ dày'],
  ])(
    'condition %s has context-specific wording, not a blind disease prefix',
    async (condition, label) => {
      const message = await intelligence.generateMessage(
        poolFor({ medical: [condition] }),
        42,
        'afternoon',
        user
      );
      expect(message.text).toContain(label);
      expect(message.text).not.toContain('bệnh đau');
    }
  );

  test('removed disease clusters cannot resurrect a condition missing from the current profile', async () => {
    const pool = poolFor({
      clusters: [symptom({ cluster_key: 'tiu_ng', display_name: 'Tiểu đường' })],
    });
    const message = await intelligence.generateMessage(pool, 42, 'afternoon', user);
    expect(message.templateId).toBe('afternoon_default');
    expect(message.text).not.toContain('tiểu đường');
    expect(message.topic).toBeNull();
  });

  test('a recent symptom takes priority without becoming a disease', async () => {
    const message = await intelligence.generateMessage(
      poolFor({ medical: ['Tiểu đường'], clusters: [symptom()] }),
      42,
      'afternoon',
      user
    );
    expect(message.templateId).toBe('afternoon_has_symptom');
    expect(message.text).toContain('đau đầu');
    expect(message.text).not.toContain('tiểu đường');
    expect(message.topic.kind).toBe('symptom');
  });

  test.each([null, 'invalid', '2026-09-27T07:00:00Z', '2026-10-06T07:00:00Z'])(
    'does not describe a symptom with an invalid or stale date %s as current',
    async (date) => {
      const message = await intelligence.generateMessage(
        poolFor({ clusters: [symptom({ last_triggered_at: date })] }),
        42,
        'afternoon',
        user
      );
      expect(message.context.topSymptom).toBeNull();
      expect(message.templateId).toBe('afternoon_default');
    }
  );

  test('known symptom names and disease names are localized for English', async () => {
    const english = { ...user, lang: 'en' };
    const disease = await intelligence.generateMessage(
      poolFor({ medical: ['Tiểu đường'] }),
      42,
      'afternoon',
      english
    );
    expect(disease.text).toContain('monitoring diabetes');
    expect(disease.text).not.toContain('Tiểu đường');
    const headache = await intelligence.generateMessage(
      poolFor({ clusters: [symptom()] }),
      42,
      'afternoon',
      english
    );
    expect(headache.text).toContain('headaches');
    expect(headache.text).not.toContain('Đau đầu');
  });

  test.each(['headache', 'tiu_ng', 'unknown_private_slug'])(
    'a severity alert never displays the internal code %s',
    async (cluster_key) => {
      const message = await intelligence.generateMessage(
        poolFor({ sessions: [{ severity: 'high', cluster_key, created_at: NOW }] }),
        42,
        'alert_severity',
        user
      );
      expect(message.text).not.toContain(cluster_key);
      expect(message.text).not.toContain('{{');
      if (cluster_key === 'headache') expect(message.text).toContain('đau đầu');
    }
  );

  test.each(['increasing', 'decreasing'])(
    'trend %s describes frequency, not a clinical worsening or improvement',
    async (trend) => {
      for (const lang of ['vi', 'en']) {
        const message = await intelligence.generateMessage(
          poolFor({ clusters: [symptom({ trend })] }),
          42,
          'morning',
          { ...user, lang }
        );
        expect(message.text).toContain(lang === 'vi' ? 'ghi nhận' : 'recorded');
        expect(message.text).not.toMatch(/đỡ hơn|nặng hơn|is improving|getting worse/);
      }
    }
  );

  test('a stale symptom cannot trigger a frequency alert', async () => {
    const trigger = await intelligence.checkAlertTriggers(
      poolFor({
        clusters: [
          symptom({ trend: 'increasing', count_7d: 8, last_triggered_at: '2026-09-01T00:00:00Z' }),
        ],
      }),
      42
    );
    expect(trigger).toBeNull();
  });

  test('none and other picker sentinels are not medical conditions', () => {
    const context = buildNotificationTopics({
      medicalConditions: ['Không có', 'Khác', 'none'],
      now: NOW,
    });
    expect(context.topCondition).toBeNull();
    expect(context.topSymptom).toBeNull();
  });

  test('a reported stomach pain can be a symptom when it is not a declared chronic condition', () => {
    const context = buildNotificationTopics({
      clusters: [symptom({ cluster_key: 'gastric_pain', display_name: 'Đau dạ dày' })],
      now: NOW,
    });
    expect(context.topSymptom.display_name).toBe('đau dạ dày');
    expect(context.topCondition).toBeNull();
  });

  test('a condition alias in a different language is still classified by its current profile type', () => {
    const context = buildNotificationTopics({
      clusters: [symptom({ cluster_key: 'gastric_pain', display_name: 'gastric pain' })],
      medicalConditions: ['Đau dạ dày'],
      now: NOW,
    });
    expect(context.topSymptom).toBeNull();
    expect(context.topCondition.code).toBe('gastric_pain');
  });

  test('an unknown label uses a localized generic description rather than leaking a code or untranslated text', () => {
    expect(resolveSymptomLabel('symptom_private_99', 'en')).toBe('recent symptoms');
    const context = buildNotificationTopics({
      medicalConditions: ['Tình trạng nhập bằng tiếng Việt'],
      language: 'en',
      now: NOW,
    });
    expect(context.topCondition.display_name).toBe('a health condition in your profile');
  });

  test('a canonical English frequency matches a Vietnamese symptom name', async () => {
    const pool = poolFor({
      clusters: [symptom({ last_triggered_at: null })],
      frequencies: [
        {
          symptom_name: 'headache',
          count_7d: 4,
          trend: 'increasing',
          last_triggered_at: '2026-10-04T17:00:00Z',
        },
      ],
    });
    const result = await intelligence.generateMessage(pool, 42, 'morning', { ...user, lang: 'en' });
    expect(result.context.topSymptom.code).toBe('headache');
    expect(result.context.topSymptom.count_7d).toBe(4);
    expect(result.text).toContain('recorded headaches more often');
  });

  test('an old frequency does not hide a newer recorded cluster timestamp', () => {
    const result = buildNotificationTopics({
      clusters: [symptom({ last_triggered_at: NOW.toISOString() })],
      frequencies: [{ symptom_name: 'headache', last_triggered_at: '2026-09-01T17:00:00Z' }],
      now: NOW,
    });
    expect(result.topSymptom.last_triggered_at).toBe(NOW.toISOString());
  });

  test('the frequency query explicitly interprets a calendar date as a Vietnam health day', async () => {
    const pool = poolFor();
    await intelligence.generateMessage(pool, 42, 'afternoon', user);
    expect(
      pool.query.mock.calls.find(([sql]) => sql.includes('FROM symptom_frequency'))[0]
    ).toContain("AT TIME ZONE 'Asia/Ho_Chi_Minh'");
    const checkinSql = pool.query.mock.calls.find(([sql]) =>
      sql.includes('FROM health_checkins')
    )[0];
    expect(checkinSql).toContain('session_date::text');
    expect(checkinSql).toContain("DATE(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')");
    expect(checkinSql).toContain('updated_at DESC, id DESC');
  });
});

describe('consecutive tired days use actual neighboring Vietnam calendar dates', () => {
  test('a six-day gap is not two consecutive days', () => {
    const checkins = [
      { session_date: '2026-10-05', initial_status: 'tired' },
      { session_date: '2026-09-29', initial_status: 'tired' },
    ];
    expect(consecutiveTiredDays(checkins, NOW)).toBe(1);
  });
  test('counts today and yesterday but does not count duplicate records twice', () => {
    const checkins = ['2026-10-05', '2026-10-05', '2026-10-04', '2026-10-03'].map(
      (session_date) => ({ session_date, initial_status: 'tired' })
    );
    expect(consecutiveTiredDays(checkins, NOW)).toBe(3);
  });
  test('resolved tiredness stops a streak and an old run is not current', () => {
    expect(
      consecutiveTiredDays(
        [
          { session_date: '2026-10-05', initial_status: 'ok' },
          { session_date: '2026-10-04', initial_status: 'tired' },
        ],
        NOW
      )
    ).toBe(0);
    expect(
      consecutiveTiredDays([{ session_date: '2026-10-02', initial_status: 'tired' }], NOW)
    ).toBe(0);
  });
  test('midnight uses the Vietnam day rather than UTC', () => {
    expect(
      consecutiveTiredDays(
        [
          { session_date: '2026-10-06', initial_status: 'tired' },
          { session_date: '2026-10-05', initial_status: 'tired' },
        ],
        new Date('2026-10-05T17:05:00Z')
      )
    ).toBe(2);
  });
});

describe('re-engagement respects typed health context', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });
  afterEach(() => {
    jest.useRealTimers();
  });
  test.each([2, 4, 7])(
    'day %s monitors diabetes instead of asking whether the disease is still present',
    async (inactive_days) => {
      const pool = poolFor({
        medical: ['Tiểu đường'],
        clusters: [symptom({ display_name: 'Tiểu đường', cluster_key: 'tiu_ng' })],
        lifecycle: { segment: 'inactive', inactive_days, last_checkin_at: '2026-09-28T07:00:00Z' },
      });
      const result = await reengagement.generateReengagementMessage(pool, 42, user);
      expect(result.message.templateId).toBe('reengage_condition');
      expect(result.message.text).toContain('theo dõi bệnh tiểu đường');
      expect(result.message.text).not.toMatch(/còn không|vẫn còn|còn kéo dài/);
      expect(result.message.topic.kind).toBe('medical_condition');
    }
  );
  test('old severe sessions are not presented as a recent incident', async () => {
    const pool = poolFor({
      sessions: [{ severity: 'high', created_at: '2026-01-01T00:00:00Z' }],
      lifecycle: { segment: 'inactive', inactive_days: 4, last_checkin_at: '2026-10-01T00:00:00Z' },
    });
    const result = await reengagement.generateReengagementMessage(pool, 42, user);
    expect(result.message.templateId).toBe('reengage_d4_concerned');
  });
  test('the day-eight family escalation remains intact', async () => {
    const pool = poolFor({
      medical: ['Tiểu đường'],
      lifecycle: { segment: 'churned', inactive_days: 8, last_checkin_at: '2026-09-27T00:00:00Z' },
    });
    const result = await reengagement.generateReengagementMessage(pool, 42, user);
    expect(result.message.templateId).toBe('reengage_d8_urgent');
    expect(result.escalation.includeFamily).toBe(true);
  });
});

describe('medication reminder wording records instructions rather than inventing a treatment', () => {
  test.each(['medication', 'evening_medication'])(
    '%s copy is record-only in both languages',
    (key) => {
      expect(t(`notification.task.${key}`, 'vi')).toContain('ghi nhận');
      expect(t(`notification.task.${key}`, 'vi')).toContain('theo hướng dẫn đã có');
      expect(t(`notification.task.${key}`, 'en')).toContain('record');
      expect(t(`notification.task.${key}`, 'en')).toContain('existing instructions');
    }
  );
});

describe('fallback copy does not revive an unverified historical diagnosis', () => {
  test.each([
    'notification.morning.fallback_with_symptom',
    'notification.morning.fallback_no_data',
    'notification.evening.fallback_with_symptom',
  ])('%s is neutral when personalized context could not be read', (key) => {
    for (const lang of ['vi', 'en']) {
      const text = t(key, lang, {
        CallName: 'Bạn Đức',
        symptom: 'unverified_private_symptom',
        tasks: 'example_task',
      });
      expect(text).not.toContain('unverified_private_symptom');
      expect(text).not.toMatch(/chưa có dữ liệu|no health data/);
      expect(text).toContain('example_task');
    }
  });
});
