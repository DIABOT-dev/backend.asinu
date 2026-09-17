describe('private media policy', () => {
  beforeEach(() => {
    process.env.CLOUDINARY_CLOUD_NAME = 'demo';
    process.env.CLOUDINARY_API_KEY = '123456789012345';
    process.env.CLOUDINARY_API_SECRET = 'demo-secret';
    process.env.CLOUDINARY_AUTH_TOKEN_KEY = '00112233445566778899aabbccddeeff';
    process.env.CLOUDINARY_ASSET_URL_TTL_SECONDS = '300';
    jest.resetModules();
  });

  afterEach(() => {
    delete process.env.CLOUDINARY_AUTH_TOKEN_KEY;
    delete process.env.CLOUDINARY_ASSET_URL_TTL_SECONDS;
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

  test('generates an authenticated expiring URL and never an upload URL', () => {
    const { authenticatedAssetUrl } = require('../../src/services/media/private-media.service');
    const url = authenticatedAssetUrl('patient-files/record-1', 'raw', 'authenticated');

    expect(url).toContain('/raw/authenticated/v1/patient-files/record-1');
    expect(url).toContain('__cld_token__=');
    expect(url).not.toContain('/upload/');
  });

  test('does not return a URL for legacy public records', () => {
    const { authenticatedAssetUrl } = require('../../src/services/media/private-media.service');
    expect(authenticatedAssetUrl('legacy-record', 'raw', 'legacy_public')).toBeNull();
  });
});
