'use strict';

jest.mock('../../src/services/notification/basic.notification.service', () => ({
  sendAndSave: jest.fn(),
}));
jest.mock('../../src/services/checkin-call/checkin-call.service', () => ({
  startEarlySignalEpisode: jest.fn(),
}));

const { _test } = require('../../src/services/early-signal/early-signal.service');

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
