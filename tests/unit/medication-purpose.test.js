'use strict';
const jwt = require('jsonwebtoken');
const { createHash } = require('node:crypto');
const purpose = require('../../src/services/v21/medication-purpose.service');
const SOURCE = 'https://dhgpharma.com.vn/vi/san-pham/giam-dau-ha-sot/hapacol-650-0';
const product = (name = 'Hapacol 650', indications = 'Điều trị các triệu chứng đau. Hạ sốt.') =>
  `<div class="field field-field-display-title field-item">${name}</div><div class="field field-field-n-p-indication"><div class="field-label">Chỉ định</div><div class="field-item"><p>${indications}</p></div></div><div class="field-field-contraindications">Tăng huyết áp, tiểu đường</div>`;
function fixture({ html = product(), urls = [SOURCE] } = {}) {
  const fetcher = jest.fn(
    async (url) =>
      new Response(
        url.endsWith('/sitemap.xml')
          ? `<urlset>${urls.map((value) => `<url><loc>${value}</loc></url>`).join('')}</urlset>`
          : html
      )
  );
  return { fetcher, resolver: purpose.createResolver({ fetcher }) };
}
test('exact verified manufacturer title yields purpose tags and its source, without contraindication tags', async () => {
  const { resolver } = fixture();
  expect(await resolver.resolve('HAPACOL 650')).toMatchObject({
    status: 'matched',
    productName: 'Hapacol 650',
    tags: ['fever_reduction', 'pain_relief'],
    source: { name: 'DHG Pharma', url: SOURCE },
  });
});
test('the field parser handles nested markup and entity encoding without executing page scripts', () => {
  expect(purpose.field(product('Hapacol <span>650</span>'), 'field-field-display-title')).toBe(
    'Hapacol 650'
  );
  expect(
    purpose.purposeCodes('Không có tác dụng hạ sốt. Chống chỉ định tăng huyết áp.', '')
  ).toEqual([]);
});
test('therapeutic targets are distinct from risk factors and ineffective previous treatments', () => {
  expect(
    purpose.purposeCodes(
      'Điều trị đái tháo đường týp 2 (không phụ thuộc insulin), khi ăn kiêng không hiệu quả.',
      ''
    )
  ).toEqual(['diabetes']);
  expect(purpose.purposeCodes('Điều trị tăng huyết áp ở bệnh nhân đái tháo đường.', '')).toEqual([
    'blood_pressure',
  ]);
  expect(
    purpose.purposeCodes(
      'Dự phòng ở người có yếu tố nguy cơ như tăng huyết áp, đái tháo đường.',
      ''
    )
  ).toEqual([]);
});
test('a close brand/variant does not become a verified match', async () => {
  const { resolver } = fixture({ html: product('Hapacol 650 Extra') });
  expect(await resolver.resolve('Hapacol 650')).toEqual({ status: 'ambiguous', tags: [] });
});
test('ambiguous family names never fetch or attach tags for an arbitrary variant', async () => {
  const { resolver, fetcher } = fixture({
    urls: [80, 150, 250, 325, 650].map((n) => SOURCE.replace('hapacol-650-0', `hapacol-${n}`)),
  });
  expect(await resolver.resolve('Hapacol')).toEqual({ status: 'ambiguous', tags: [] });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
test('a generic quick label and an unknown brand remain unclassified', async () => {
  const { resolver, fetcher } = fixture();
  expect(await resolver.resolve('Thuốc huyết áp')).toEqual({ status: 'not_found', tags: [] });
  expect(fetcher).not.toHaveBeenCalled();
  expect(await resolver.resolve('Unrecognized brand')).toEqual({ status: 'not_found', tags: [] });
});
test('external, credentialed and misleading sitemap URLs never receive requests', async () => {
  const { resolver, fetcher } = fixture({
    urls: [
      'http://127.0.0.1/hapacol-650',
      'https://dhgpharma.com.vn.evil.test/vi/san-pham/giam-dau-ha-sot/hapacol-650',
      'https://user@dhgpharma.com.vn/vi/san-pham/giam-dau-ha-sot/hapacol-650',
    ],
  });
  expect((await resolver.resolve('Hapacol 650')).status).toBe('unavailable');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
test('concurrent duplicate lookups share requests and cache only public catalog data', async () => {
  const { resolver, fetcher } = fixture();
  await Promise.all([resolver.resolve('Hapacol 650'), resolver.resolve('HAPACOL 650')]);
  await resolver.resolve('Hapacol 650');
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls.every(([url]) => url.startsWith('https://dhgpharma.com.vn/'))).toBe(
    true
  );
});
test('network errors and excessive source documents return an unavailable result instead of breaking setup', async () => {
  const offline = purpose.createResolver({
    fetcher: async () => {
      throw new Error('offline');
    },
  });
  expect(await offline.resolve('Hapacol 650')).toEqual({ status: 'unavailable', tags: [] });
  const oversized = purpose.createResolver({
    fetcher: async () => new Response('x'.repeat(1500001)),
  });
  expect((await oversized.resolve('Hapacol 650')).status).toBe('unavailable');
});
describe('explicit tag confirmation', () => {
  beforeEach(() => {
    process.env.JWT_SECRET = 'medication-purpose-fixture-secret';
    delete process.env.MED_MEDIA_SIGNING_KEY;
  });
  const token = (override = {}, options = {}) =>
    jwt.sign(
      {
        purpose: 'med-purpose-tags',
        actor: 1,
        patient: 2,
        name: createHash('sha256').update('hapacol 650').digest('hex'),
        productName: 'Hapacol 650',
        tags: ['pain_relief', 'fever_reduction'],
        source: { name: 'DHG Pharma', url: SOURCE },
        ...override,
      },
      'medication-purpose-fixture-secret',
      { algorithm: 'HS256', expiresIn: '1h', ...options }
    );
  const item = () => ({
    display_name: 'Hapacol 650',
    kind: 'MEDICINE',
    tag_confirmation: { token: token(), codes: ['pain_relief'] },
  });
  test('only explicitly selected tags are persisted with provenance', () => {
    expect(purpose.confirmedTags(1, 2, item())).toMatchObject({
      codes: ['pain_relief'],
      productName: 'Hapacol 650',
      confirmedBy: 1,
      source: { url: SOURCE },
    });
    expect(purpose.confirmedTags(1, 2, { display_name: 'Hapacol 650' })).toBeNull();
  });
  test.each([
    { display_name: 'Hapacol 650 Extra' },
    { kind: 'SUPPLEMENT' },
    { tag_confirmation: { token: token(), codes: ['diabetes'] } },
    { tag_confirmation: { token: token({ actor: 3 }), codes: ['pain_relief'] } },
    { tag_confirmation: { token: token({ patient: 3 }), codes: ['pain_relief'] } },
  ])('rejects a stale or forged tag confirmation, case %#', (change) => {
    expect(() => purpose.confirmedTags(1, 2, { ...item(), ...change })).toThrow();
  });
  test('expired confirmations cannot be replayed', () => {
    expect(() =>
      purpose.confirmedTags(1, 2, {
        ...item(),
        tag_confirmation: { token: token({}, { expiresIn: -1 }), codes: ['pain_relief'] },
      })
    ).toThrow(expect.objectContaining({ code: 'MED_TAG_CONFIRMATION_EXPIRED' }));
  });
});
