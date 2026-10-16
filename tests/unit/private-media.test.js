describe('private media policy', () => {
  beforeEach(() => {
    process.env.CLOUDINARY_CLOUD_NAME = 'demo';
    process.env.CLOUDINARY_API_KEY = '123456789012345';
    process.env.CLOUDINARY_API_SECRET = 'demo-secret';
    jest.resetModules();
  });

  afterEach(() => {
    delete process.env.CLOUDINARY_CLOUD_NAME;
    delete process.env.CLOUDINARY_API_KEY;
    delete process.env.CLOUDINARY_API_SECRET;
  });

  test('requires the declared MIME type to match the file signature', () => {
    const { isSupportedPatientFile } = require('../../src/services/media/private-media.service');
    const pdf = Buffer.from('%PDF-1.7\npatient record');
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00,
    ]);

    expect(isSupportedPatientFile(pdf, 'application/pdf')).toBe(true);
    expect(isSupportedPatientFile(pdf, 'image/png')).toBe(false);
    expect(isSupportedPatientFile(png, 'image/png')).toBe(true);
  });

  test('signs a five-minute authenticated API download, including its expiry', () => {
    const { authenticatedAssetUrl, MEDIA_URL_TTL_SECONDS } = require('../../src/services/media/private-media.service');
    const { v2: cloudinary } = require('cloudinary');
    const now = Math.floor(Date.now() / 1000);
    const url = new URL(authenticatedAssetUrl('patient-files/record-1', 'raw', 'authenticated', 'application/pdf'));
    expect(url.hostname).toBe('api.cloudinary.com');
    expect(url.pathname).toBe('/v1_1/demo/raw/download');
    expect(url.searchParams.get('type')).toBe('authenticated');
    expect(url.searchParams.get('format')).toBe('pdf');
    const expiry = Number(url.searchParams.get('expires_at'));
    expect(expiry).toBeGreaterThanOrEqual(now + MEDIA_URL_TTL_SECONDS);
    expect(expiry).toBeLessThanOrEqual(now + MEDIA_URL_TTL_SECONDS + 1);
    const params = Object.fromEntries(url.searchParams);
    const signature = params.signature;
    delete params.signature; delete params.api_key;
    expect(cloudinary.utils.api_sign_request(params, 'demo-secret')).toBe(signature);
    params.expires_at = String(expiry + 3600);
    expect(cloudinary.utils.api_sign_request(params, 'demo-secret')).not.toBe(signature);
  });

  test('does not return a URL for legacy public records', () => {
    const { authenticatedAssetUrl } = require('../../src/services/media/private-media.service');
    expect(authenticatedAssetUrl('legacy-record', 'raw', 'legacy_public')).toBeNull();
  });

  test('polling reuses a valid link but renews it before expiry', () => {
    jest.useFakeTimers({ now: new Date('2026-10-16T00:00:00Z') });
    try {
      const { authenticatedAssetUrl } = require('../../src/services/media/private-media.service');
      const first = authenticatedAssetUrl('thread/voice-1', 'video', 'authenticated', 'audio/m4a');
      jest.advanceTimersByTime(15000);
      expect(authenticatedAssetUrl('thread/voice-1', 'video', 'authenticated', 'audio/m4a')).toBe(first);
      jest.advanceTimersByTime(260000);
      const renewed = authenticatedAssetUrl('thread/voice-1', 'video', 'authenticated', 'audio/m4a');
      expect(renewed).not.toBe(first);
      expect(Number(new URL(renewed).searchParams.get('expires_at'))).toBeGreaterThan(Date.now() / 1000);
    } finally { jest.useRealTimers(); }
  });
});
