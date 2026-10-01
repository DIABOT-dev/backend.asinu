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
    const result = _test.analyse(snapshot({
      symptoms: [{ symptom_name: 'đau ngực và khó thở', occurred_date: new Date().toISOString() }],
    }));
    expect(result).toMatchObject({ severity: 'urgent', is_red_flag: true });
    expect(result.urgent_signs).toEqual(expect.arrayContaining(['Đau ngực', 'Khó thở']));
    expect(result.summary).toContain('gọi 115');
  });

  test('a repeated symptom recommends medical review without diagnosis', () => {
    const occurredDate = new Date().toISOString();
    const result = _test.analyse(snapshot({
      symptoms: Array.from({ length: 4 }, () => ({
        symptom_name: 'chóng mặt',
        occurred_date: occurredDate,
      })),
    }));
    expect(result).toMatchObject({ severity: 'see_doctor', is_red_flag: false });
    expect(result.summary).toContain('Nên được bác sĩ đánh giá');
    expect(result.summary).not.toMatch(/chẩn đoán|mắc bệnh|không sao đâu/i);
  });

  test('blocks diagnosis, medicine and false-reassurance language', () => {
    for (const summary of [
      'Bố bị viêm đại tràng.',
      'Uống thuốc aspirin 100mg.',
      'Không sao đâu.',
    ]) {
      expect(() => _test.validateSafeOutput({ summary, urgent_signs: [] }))
        .toThrow('Unsafe early signal output');
    }
  });
});
