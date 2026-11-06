'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const rules = require('../../src/lib/blood-pressure');

jest.mock('../../src/i18n', () => ({ t: (key) => key, getLang: () => 'vi' }));
jest.mock('../../src/services/profile/mobile.service', () => ({ createLog: jest.fn() }));
jest.mock('../../src/services/early-signal/early-signal.service', () => ({
  evaluateAfterNewHealthData: jest.fn().mockResolvedValue(undefined),
}));
const currentSchema = require('../../src/validation/validation.schemas').logDataSchemas.bp;
const legacySchema = require('../../src/validation/schemas').logDataSchemas.bp;
const { createMobileLog } = require('../../src/controllers/mobile.controller');
const mobileService = require('../../src/services/profile/mobile.service');
const adult = { age: 40 };
const now = new Date('2026-11-03T00:00:00Z');

describe('AHA/ACC 2025 adult reading categories', () => {
  test.each([
    [118, 78, 'normal'],
    [119.9, 79.9, 'normal'],
    [120, 79, 'elevated'],
    [129.9, 79.9, 'elevated'],
    [120, 80, 'stage1'],
    [130, 79, 'stage1'],
    [139, 89, 'stage1'],
    [140, 79, 'stage2'],
    [128, 98, 'stage2'],
    [150, 55, 'stage2'],
    [130, 55, 'stage1'],
    [125, 55, 'elevated'],
    [180, 120, 'stage2'],
    [181, 70, 'severe'],
    [160, 121, 'severe'],
    [200, 55, 'severe'],
    [190, 130, 'severe'],
  ])('%s/%s is %s, using the higher pressure category', (sys, dia, category) => {
    expect(rules.assessBloodPressure(sys, dia, adult, now).category).toBe(category);
  });
  test('low values are an additional finding and cannot hide a high systolic reading', () => {
    expect(rules.assessBloodPressure(85, 55, adult, now)).toMatchObject({
      category: 'normal',
      displayCategory: 'low',
      low: true,
    });
    expect(rules.assessBloodPressure(200, 55, adult, now)).toMatchObject({
      category: 'severe',
      displayCategory: 'severe',
      low: true,
    });
    expect(rules.assessBloodPressure(90, 60, adult, now)).toMatchObject({
      displayCategory: 'normal',
      low: false,
    });
  });
  test('the exact severe boundary requests a repeat without inventing a higher AHA category', () => {
    expect(rules.assessBloodPressure(180, 120, adult, now)).toMatchObject({
      category: 'stage2',
      veryHigh: false,
      repeatHigh: true,
    });
  });
  test.each([
    { age: 18, gender: 'Nam', weightKg: 50 },
    { age: 40, gender: 'Nữ', weightKg: 100 },
    { age: 85, gender: 'Nam', weightKg: 75 },
  ])('age, sex and weight do not arbitrarily raise the normal threshold: %j', (profile) => {
    expect(rules.assessBloodPressure(135, 85, profile, now).category).toBe('stage1');
  });
  test.each([
    undefined,
    {},
    { age: null },
    { age: -1 },
    { age: 200 },
    { dateOfBirth: '2000-02-30', age: 40 },
  ])('missing or invalid age has no adult diagnosis label: %j', (profile) => {
    expect(rules.assessBloodPressure(118, 78, profile, now)).toMatchObject({
      scope: 'unknown_age',
      category: null,
      displayCategory: null,
    });
    expect(rules.bloodPressureMetricStatus(118, 78, profile, now)).toBe('available');
  });
  test('under-18 readings are recorded without adult normal or low labels', () => {
    expect(rules.assessBloodPressure(85, 55, { age: 10 }, now)).toMatchObject({
      valid: true,
      scope: 'under18',
      category: null,
      displayCategory: null,
      low: false,
    });
  });
  test('age follows the actual birthday in the Vietnam calendar', () => {
    const profile = { dateOfBirth: '2008-11-03', age: 99 };
    expect(rules.bloodPressureAge(profile, new Date('2026-11-02T16:59:59Z'))).toBe(17);
    expect(rules.bloodPressureAge(profile, new Date('2026-11-02T17:00:00Z'))).toBe(18);
    expect(rules.bloodPressureAge({ birthYear: '1980' }, now)).toBe(46);
  });
});

describe.each([
  ['current', currentSchema],
  ['legacy', legacySchema],
])('%s blood pressure ingestion', (_name, schema) => {
  test.each([
    [80, 120],
    [120, 120],
    [50, 150],
    [0, 0],
    [251, 90],
    [120, 151],
    ['120abc', 80],
    ['1e2', 60],
    [null, 80],
    ['', 80],
    [true, 80],
  ])('rejects invalid or inverted values %s/%s', (systolic, diastolic) => {
    expect(schema.safeParse({ systolic, diastolic }).success).toBe(false);
  });
  test('accepts valid numeric input and canonical mmHg without reducing high readings', () => {
    expect(schema.parse({ systolic: '200', diastolic: '55', pulse: '72', unit: 'mmhg' })).toEqual({
      systolic: 200,
      diastolic: 55,
      pulse: 72,
      unit: 'mmHg',
    });
  });
  test.each([29, 221, '72abc', Number.NaN])('rejects invalid pulse %s', (pulse) => {
    expect(schema.safeParse({ systolic: 120, diastolic: 80, pulse }).success).toBe(false);
  });
  test('accepts omitted pulse and rejects mismatched measurement units', () => {
    expect(schema.safeParse({ systolic: 120, diastolic: 80 }).success).toBe(true);
    expect(schema.safeParse({ systolic: 120, diastolic: 80, unit: 'kPa' }).success).toBe(false);
  });
});

describe('actual recording controller', () => {
  const response = () => {
    const res = {};
    res.set = jest.fn(() => res);
    res.status = jest.fn(() => res);
    res.json = jest.fn(() => res);
    return res;
  };
  beforeEach(() => jest.clearAllMocks());
  test('an inverted reading cannot reach the database service', async () => {
    const res = response();
    await createMobileLog(
      {},
      {
        user: { id: 7 },
        body: {
          log_type: 'bp',
          occurred_at: now.toISOString(),
          data: { systolic: 80, diastolic: 120 },
        },
      },
      res
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mobileService.createLog).not.toHaveBeenCalled();
  });
  test('valid high readings still save unchanged for clinical review', async () => {
    mobileService.createLog.mockResolvedValueOnce({ ok: true, logId: 1, logType: 'bp' });
    const res = response();
    await createMobileLog(
      {},
      {
        user: { id: 7 },
        body: {
          log_type: 'bp',
          occurred_at: now.toISOString(),
          data: { systolic: 200, diastolic: 55, unit: 'mmHg' },
        },
      },
      res
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(mobileService.createLog).toHaveBeenCalledWith(
      {},
      7,
      expect.objectContaining({ data: { systolic: 200, diastolic: 55, unit: 'mmHg' } })
    );
  });
});

describe('actual Overview metric query', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../../src/services/tree/tree.service.js'),
    'utf8'
  );
  const getLatestMetrics = vm.runInNewContext(`${source}\ngetLatestMetrics`, {
    module: { exports: {} },
    require: (name) => {
      if (name === '../../lib/blood-pressure') return rules;
      if (name === '../../i18n') return { t: (key) => key };
      if (name === '../../lib/redis' || name === '../checkin/checkin.service') return {};
      throw new Error(`Unexpected tree dependency: ${name}`);
    },
  });
  test.each([
    [128, 98, 'monitor'],
    [135, 85, 'monitor'],
    [200, 55, 'danger'],
    [260, 160, 'danger'],
    [160, 125, 'danger'],
    [118, 78, 'stable'],
    [85, 55, 'monitor'],
  ])('%s/%s is %s in Overview using both numbers', async (systolic, diastolic, status) => {
    const pool = {
      query: jest.fn(async (sql) => ({
        rows: sql.includes('FROM blood_pressure_logs')
          ? [{ systolic, diastolic, date_of_birth: '1980-01-01', unit: 'mmHg' }]
          : [],
      })),
    };
    const metrics = await getLatestMetrics(pool, 7);
    expect(metrics.bloodPressure.status).toBe(status);
    expect(metrics.bloodPressure.classificationStandard).toBe('AHA_ACC_2025');
  });
  test('missing age cannot turn an unassessed reading into a green stable metric', async () => {
    const pool = {
      query: jest.fn(async (sql) => ({
        rows: sql.includes('FROM blood_pressure_logs') ? [{ systolic: 118, diastolic: 78 }] : [],
      })),
    };
    const metrics = await getLatestMetrics(pool, 7);
    expect(metrics.bloodPressure.status).toBe('available');
    expect(metrics.bloodPressure.classification).toBeNull();
  });
});

describe('actual home health score', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../../src/services/checkin/checkin.service.js'),
    'utf8'
  );
  const start = source.indexOf('async function getHealthScore(');
  const end = source.indexOf('\n/**', start);
  const getHealthScore = vm.runInNewContext(`(${source.slice(start, end)})`, {
    assessBloodPressure: rules.assessBloodPressure,
    bloodPressureMetricStatus: rules.bloodPressureMetricStatus,
    cacheGet: async () => null,
    cacheSet: async () => {},
    checkinDateVN: () => '2026-11-03',
  });
  test.each([
    [128, 98, 'monitor', 'diastolic_high'],
    [135, 85, 'monitor', 'systolic_high'],
    [125, 79, 'monitor', 'systolic_high'],
    [85, 55, 'monitor', 'blood_pressure_low'],
    [200, 55, 'danger', 'systolic_very_high'],
    [260, 160, 'danger', 'diastolic_very_high'],
    [160, 125, 'danger', 'diastolic_very_high'],
    [180, 120, 'danger', 'diastolic_very_high'],
    [118, 78, 'ok', null],
  ])(
    '%s/%s has level %s and a reason matching the actual pressure',
    async (systolic, diastolic, level, factor) => {
      const pool = {
        query: jest.fn(async (sql) => ({
          rows: sql.includes('FROM blood_pressure_logs')
            ? [{ systolic, diastolic, date_of_birth: '1980-01-01' }]
            : [],
        })),
      };
      const result = await getHealthScore(pool, 7);
      expect(result.level).toBe(level);
      if (factor) expect(result.factors).toContain(factor);
      else expect(result.factors).toHaveLength(0);
      expect(
        pool.query.mock.calls.find(([sql]) => sql.includes('FROM blood_pressure_logs'))[0]
      ).toContain('bp.diastolic');
    }
  );
  test('invalid legacy pressure pairs cannot produce adult pressure factors', async () => {
    const pool = {
      query: jest.fn(async (sql) => ({
        rows: sql.includes('FROM blood_pressure_logs')
          ? [{ systolic: 80, diastolic: 120, date_of_birth: '1980-01-01' }]
          : [],
      })),
    };
    expect((await getHealthScore(pool, 7)).factors).toHaveLength(0);
  });
});

describe('actual daily BP alert selection', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../../src/services/health/health.monitoring.service.js'),
    'utf8'
  );
  const start = source.indexOf('async function checkBloodPressureAlerts(');
  const end = source.indexOf('\n/**', start);
  const checkAlerts = vm.runInNewContext(`(${source.slice(start, end)})`, {
    assessBloodPressure: rules.assessBloodPressure,
  });
  test.each([
    [200, 55, 'high_blood_pressure'],
    [260, 160, 'high_blood_pressure'],
    [160, 125, 'high_blood_pressure'],
    [85, 55, 'low_blood_pressure'],
    [150, 55, null],
    [128, 98, null],
    [80, 120, null],
  ])(
    '%s/%s selects %s without falsely labelling a mixed high reading as low',
    async (systolic, diastolic, type) => {
      const pool = {
        query: jest.fn(async () => ({
          rows: [{ systolic, diastolic, date_of_birth: '1980-01-01' }],
        })),
      };
      expect((await checkAlerts(pool, 7))?.type ?? null).toBe(type);
    }
  );
  test('no adult low-pressure alert is applied to a child', async () => {
    const pool = {
      query: jest.fn(async () => ({
        rows: [{ systolic: 85, diastolic: 55, date_of_birth: '2020-01-01' }],
      })),
    };
    expect(await checkAlerts(pool, 7)).toBeNull();
  });
});
