'use strict';

jest.mock('../../src/services/notification/basic.notification.service', () => ({
  sendAndSave: jest.fn(),
}));
jest.mock('../../src/services/checkin-call/checkin-call.service', () => ({
  startEarlySignalEpisode: jest.fn(),
}));

const earlySignalService = require('../../src/services/early-signal/early-signal.service');
const entitlementService = require('../../src/services/payment/entitlement.service');
const { _test } = earlySignalService;

function snapshot(overrides = {}) {
  return {
    checkins: [],
    symptoms: [],
    vitals: [],
    profile: null,
    ...overrides,
  };
}

describe('Early Signals clinical output guardrails', () => {
  test('a red-flag phrase bypasses routine advice', () => {
    const result = _test.analyse(
      snapshot({
        symptoms: [
          { symptom_name: 'đau ngực và khó thở', occurred_date: new Date().toISOString() },
        ],
      })
    );
    expect(result).toMatchObject({ severity: 'urgent', is_red_flag: true });
    expect(result.urgent_signs).toEqual(expect.arrayContaining(['Đau ngực', 'Khó thở']));
    expect(result.summary).toContain('gọi 115');
  });

  test('a repeated symptom recommends medical review without diagnosis', () => {
    const occurredDate = new Date().toISOString();
    const result = _test.analyse(
      snapshot({
        symptoms: Array.from({ length: 4 }, () => ({
          symptom_name: 'chóng mặt',
          occurred_date: occurredDate,
        })),
      })
    );
    expect(result).toMatchObject({ severity: 'see_doctor', is_red_flag: false });
    expect(result.summary).toContain('Nên kiểm tra tại chuyên khoa Thần kinh');
    expect(result.suggested_specialty).toBe('Thần kinh');
    expect(result.summary).not.toMatch(/chẩn đoán|mắc bệnh|không sao đâu/i);
  });

  test('localizes the assessment to the selected English language', () => {
    const occurredDate = new Date().toISOString();
    const result = _test.analyse(
      snapshot({
        symptoms: Array.from({ length: 4 }, () => ({
          symptom_name: 'dizziness',
          occurred_date: occurredDate,
        })),
      }),
      'en'
    );
    expect(result).toMatchObject({
      severity: 'see_doctor',
      suggested_specialty: 'Neurology',
    });
    expect(result.summary).toContain('Consider an assessment in Neurology');
    expect(result.disclaimer).toBe('This information is for guidance only and is not a diagnosis.');
  });

  test('localizes a very-tired result even without a symptom log', () => {
    const result = _test.analyse(
      snapshot({
        checkins: [{ session_date: new Date().toISOString(), current_status: 'very_tired' }],
      }),
      'en'
    );
    expect(result.severity).toBe('see_doctor');
    expect(result.summary).toContain('feeling very tired');
    expect(result.summary).not.toContain('mệt');
    expect(result.signals[0]).toContain('feeling very tired');
  });

  test('an old red-flag phrase stays in history without showing a current emergency', () => {
    const occurredDate = new Date();
    occurredDate.setDate(occurredDate.getDate() - 2);
    const result = _test.analyse(
      snapshot({
        symptoms: [{ symptom_name: 'đau ngực', occurred_date: occurredDate.toISOString() }],
      })
    );
    expect(result).toMatchObject({ severity: 'monitor', is_red_flag: false });
  });

  test('blocks diagnosis, medicine and false-reassurance language', () => {
    for (const summary of [
      'Bố bị viêm đại tràng.',
      'Uống thuốc aspirin 100mg.',
      'Không sao đâu.',
    ]) {
      expect(() =>
        _test.validateSafeOutput({
          summary,
          signals: [],
          urgent_signs: [],
          disclaimer: 'Đây là gợi ý tham khảo, không phải chẩn đoán.',
        })
      ).toThrow('Unsafe early signal output');
    }
  });

  test('blocks a medication name copied from the input data', () => {
    expect(() =>
      _test.validateSafeOutput(
        {
          summary: 'Hãy tiếp tục dùng Metformin.',
          signals: [],
          urgent_signs: [],
          disclaimer: 'Đây là gợi ý tham khảo, không phải chẩn đoán.',
        },
        ['Metformin']
      )
    ).toThrow('Unsafe early signal output');
  });
});

describe('Early Signals family access', () => {
  afterEach(() => jest.restoreAllMocks());

  test('free result cannot be evaluated or read by a connected family member', async () => {
    jest.spyOn(entitlementService, 'getEntitlement').mockResolvedValue({
      automaticEarlySignals: false,
    });
    const pool = { query: jest.fn() };

    await expect(earlySignalService.latest(pool, 8, 7)).rejects.toMatchObject({
      statusCode: 403,
      code: 'FORBIDDEN',
    });
    await expect(earlySignalService.evaluate(pool, 8, { requestedBy: 7 })).rejects.toMatchObject({
      statusCode: 403,
      code: 'FORBIDDEN',
    });
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('paid protected member still requires a family relationship or log permission', async () => {
    jest.spyOn(entitlementService, 'getEntitlement').mockResolvedValue({
      automaticEarlySignals: true,
    });
    const pool = { query: jest.fn().mockResolvedValue({ rowCount: 0, rows: [] }) };

    await expect(earlySignalService.latest(pool, 8, 7)).rejects.toMatchObject({
      statusCode: 403,
      code: 'FORBIDDEN',
    });
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  test('family list excludes free and expired households', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    await earlySignalService.familyLatest(pool, 7);
    expect(pool.query.mock.calls[0][0]).toContain("h.plan_code <> 'free'");
    expect(pool.query.mock.calls[0][0]).toContain('h.current_period_end > NOW()');
  });
});
