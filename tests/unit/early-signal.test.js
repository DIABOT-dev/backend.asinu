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

  test('conditional instructions in a conclusion cannot become current symptoms', () => {
    const result = _test.analyse(snapshot({
      checkins: [{
        session_date: new Date().toISOString(), current_status: 'tired',
        triage_summary: 'Nếu đau ngực, khó thở, nôn ra máu hoặc yếu liệt thì cần hỗ trợ ngay.',
        triage_messages: [{ question: 'Bạn khó chịu ở đâu?', answer: 'Đau đầu' }],
      }],
    }));
    expect(result).toMatchObject({ severity: 'monitor', is_red_flag: false });
  });

  test('an unselected choice and a denied symptom cannot trigger an urgent assessment', () => {
    const result = _test.analyse(snapshot({
      checkins: [{
        session_date: new Date().toISOString(), current_status: 'tired',
        triage_messages: [{
          question: 'Bạn có đau ngực, khó thở hoặc nôn ra máu không?',
          options: ['Đau ngực', 'Khó thở', 'Nôn ra máu', 'Không có'],
          answer: 'Không có',
        }, { question: 'Mô tả thêm', answer: 'Tôi không bị đau ngực và khó thở' }],
      }],
    }));
    expect(result).toMatchObject({ severity: 'monitor', is_red_flag: false });
  });

  test.each(['checkins', 'scripted_checkins'])('%s retains an explicitly reported urgent symptom', source => {
    const answers = [{ question: 'Bạn thấy thế nào?', answer: ['Đau ngực', 'Khó thở'] }];
    const record = source === 'checkins'
      ? { session_date: new Date().toISOString(), triage_messages: answers }
      : { created_at: new Date().toISOString(), answers };
    const result = _test.analyse(snapshot({ [source]: [record] }));
    expect(result).toMatchObject({ severity: 'urgent', is_red_flag: true });
    expect(result._i18n.urgentSigns).toEqual(expect.arrayContaining(['chest_pain', 'shortness_of_breath']));
  });

  test('script conclusion warnings are excluded when the answers deny warning signs', () => {
    const result = _test.analyse(snapshot({
      scripted_checkins: [{
        created_at: new Date().toISOString(), severity: 'low',
        conclusion_summary: 'Seek help if chest pain or shortness of breath develops.',
        answers: [{ question_id: 'red_flags', answer: 'No chest pain or shortness of breath' }],
      }],
    }));
    expect(result).toMatchObject({ severity: 'monitor', is_red_flag: false });
  });

  test('a negated sentence does not hide a separate affirmative sentence', () => {
    const result = _test.analyse(snapshot({
      symptoms: [{ symptom_name: 'Không đau ngực. Tôi đang khó thở.', occurred_date: new Date().toISOString() }],
    }));
    expect(result).toMatchObject({ severity: 'urgent', is_red_flag: true });
    expect(result._i18n.urgentSigns).toEqual(['shortness_of_breath']);
  });

  test.each(['manual', 'script'])('an explicit %s emergency survives without a symptom phrase', source => {
    const record = source === 'manual'
      ? { checkins: [{ session_date: new Date().toISOString(), emergency_triggered: true }] }
      : { scripted_checkins: [{ completed_at: new Date().toISOString(), severity: 'critical', answers: [] }] };
    expect(_test.analyse(snapshot(record))).toMatchObject({ severity: 'urgent', is_red_flag: true });
  });

  test('the repeated very-tired rule remains separate from explicit red flags', () => {
    const result = _test.analyse(snapshot({
      checkins: Array.from({ length: 2 }, (_, index) => ({
        session_date: new Date(Date.now() - index * 86400000).toISOString(), current_status: 'very_tired',
        triage_summary: 'Nếu có đau ngực hoặc khó thở hãy tìm hỗ trợ.', triage_messages: [],
      })),
    }));
    expect(result).toMatchObject({ severity: 'urgent', is_red_flag: false });
    expect(result._i18n.signals.map(item => item.key)).toEqual(['early_signal.signal.very_tired']);
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

describe('Early Signals call dispatch', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  test.each([
    { reported: false, patientPresent: false }, { reported: true, patientPresent: false },
    { reported: false, patientPresent: true }, { reported: true, patientPresent: true },
  ])('call routing preserves patient presence (reported=$reported, present=$patientPresent)', async ({ reported, patientPresent }) => {
    jest.spyOn(entitlementService, 'getEntitlement').mockResolvedValue({
      automaticEarlySignals: true, callCenterEnabled: true,
    });
    const calls = require('../../src/services/checkin-call/checkin-call.service');
    calls.startEarlySignalEpisode.mockResolvedValue({ id: 'synthetic-call' });
    const pool = { query: jest.fn(async (sql, params) => {
      if (sql.includes('FROM health_checkins')) return { rows: [{
        session_date: new Date().toISOString(), current_status: 'tired',
        triage_summary: 'Nếu đau ngực, khó thở, nôn ra máu hoặc yếu liệt thì cần hỗ trợ ngay.',
        triage_messages: [{ question: 'Bạn có đau ngực không?', answer: reported ? 'Đau ngực' : 'Không có' }],
      }] };
      if (sql.includes('SELECT severity FROM early_signal_assessments')) return { rows: [{ severity: 'monitor' }] };
      if (sql.includes('INSERT INTO early_signal_assessments')) return { rows: [{
        id: 'synthetic-assessment', trigger_type: params[2], severity: params[5], is_red_flag: params[6],
        output_snapshot: JSON.parse(params[12]),
      }] };
      return { rows: [], rowCount: 0 };
    }) };
    const result = await earlySignalService.evaluateAfterNewHealthData(pool, 7, 'synthetic-source-check', { patientPresent });
    expect(result.is_red_flag).toBe(reported);
    if (reported) {
      expect(calls.startEarlySignalEpisode).toHaveBeenCalledWith(pool, 7, 'synthetic-assessment', { patientPresent });
      expect(result.call_episode_id).toBe('synthetic-call');
    } else {
      expect(calls.startEarlySignalEpisode).not.toHaveBeenCalled();
      expect(require('../../src/services/notification/basic.notification.service').sendAndSave).not.toHaveBeenCalled();
    }
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
