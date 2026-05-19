const { AppError, asAppError, ERROR_CODES } = require('../../src/lib/errors');

describe('AppError', () => {
  test('maps code key to http status', () => {
    const err = new AppError('NOT_FOUND', { message: 'no such payment' });
    expect(err.statusCode).toBe(404);
    expect(err.code).toBe('NOT_FOUND');
    expect(err.message).toBe('no such payment');
  });

  test('falls back to INTERNAL_ERROR for unknown code', () => {
    const err = new AppError('FAKE_CODE');
    expect(err.statusCode).toBe(500);
    expect(err.code).toBe('INTERNAL_ERROR');
  });

  test('toJSON never leaks cause or details', () => {
    const cause = new Error('postgres exploded');
    const err = new AppError('UPSTREAM_FAILED', {
      message: 'payment provider unavailable',
      cause,
      details: { internal: 'secret stack' },
    });
    const json = err.toJSON();
    expect(json).toEqual({ ok: false, error: 'payment provider unavailable', code: 'UPSTREAM_FAILED' });
    expect(json.cause).toBeUndefined();
    expect(json.details).toBeUndefined();
  });
});

describe('asAppError', () => {
  test('passes AppError through', () => {
    const original = new AppError('CONFLICT', { message: 'dup' });
    expect(asAppError(original)).toBe(original);
  });

  test('wraps unknown error', () => {
    const wrapped = asAppError(new Error('???'));
    expect(wrapped).toBeInstanceOf(AppError);
    expect(wrapped.code).toBe('INTERNAL_ERROR');
  });
});

test('ERROR_CODES has stable shape', () => {
  for (const key of Object.keys(ERROR_CODES)) {
    expect(typeof ERROR_CODES[key].http).toBe('number');
    expect(typeof ERROR_CODES[key].code).toBe('string');
  }
});
