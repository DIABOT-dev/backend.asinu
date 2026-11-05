'use strict';

const jwt = require('jsonwebtoken');
const { createHash } = require('node:crypto');
const c = require('./common');

const ORIGIN = 'https://dhgpharma.com.vn';
const TAG_CODES = [
  'fever_reduction',
  'pain_relief',
  'blood_pressure',
  'diabetes',
  'lipids',
  'antibiotic',
  'allergy',
  'cough',
  'stomach',
];
const normalizeName = (value) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
const nameHash = (value) => createHash('sha256').update(normalizeName(value)).digest('hex');
const signingKey = () => {
  if (!process.env.JWT_SECRET) throw c.error('MED_LOOKUP_UNAVAILABLE', 503);
  return process.env.MED_MEDIA_SIGNING_KEY || process.env.JWT_SECRET;
};
const inputSchema = c.z
  .object({ name: c.z.string().trim().min(2).max(120), kind: c.z.enum(['MEDICINE', 'SUPPLEMENT']) })
  .strict();
const confirmationSchema = c.z
  .object({
    token: c.z.string().min(20).max(4096),
    codes: c.z
      .array(c.z.enum(TAG_CODES))
      .min(1)
      .max(TAG_CODES.length)
      .refine((codes) => new Set(codes).size === codes.length),
  })
  .strict();

function plainText(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>|<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?\s*>|<\/p>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, n) => {
      const code = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .trim();
}
// Read only a specific Drupal field, never side effects, contraindications or page navigation.
function field(html, className) {
  const opening = new RegExp(
    '<div\\b[^>]*class="[^"]*\\b' + className + '\\b[^"]*"[^>]*>',
    'i'
  ).exec(html);
  if (!opening) return '';
  const tags = /<\/?div\b[^>]*>/gi;
  tags.lastIndex = opening.index + opening[0].length;
  let depth = 1,
    next;
  while ((next = tags.exec(html))) {
    depth += /^<\//.test(next[0]) ? -1 : 1;
    if (!depth) return plainText(html.slice(opening.index + opening[0].length, next.index));
  }
  return '';
}
function purposeCodes(indications, category) {
  const lines = indications
    .split(/[.;\n]+/)
    .map(normalizeName)
    .filter((line) => line && !/\b(chong chi dinh|than trong)\b/.test(line));
  const positiveMatch = (expression) =>
    lines.some((line) => {
      for (const match of line.matchAll(new RegExp(expression.source, 'g'))) {
        const before = line.slice(Math.max(0, match.index - 60), match.index);
        if (!/\bkhong\b[^\n]{0,60}$/.test(before)) return true;
      }
      return false;
    });
  const rules = [
    ['fever_reduction', /\bha sot\b/],
    ['pain_relief', /\bgiam dau\b|\bdieu tri cac trieu chung dau\b/],
    [
      'blood_pressure',
      /^(?:benh )?(?:tang|cao) huyet ap\b|\b(?:dieu tri|kiem soat) (?:benh )?(?:tang|cao) huyet ap\b/,
    ],
    [
      'diabetes',
      /^(?:benh )?(?:dai thao duong|tieu duong)\b|\b(?:dieu tri|kiem soat) (?:benh )?(?:dai thao duong|tieu duong)\b/,
    ],
    [
      'lipids',
      /\btang (?:lipid|cholesterol|triglycerid)\b|\broi loan lipid\b|\bha (?:lipid|cholesterol)\b/,
    ],
    ['allergy', /\bviem mui di ung\b|\bmay day\b/],
    ['cough', /\bgiam ho\b|\bdieu tri ho\b/],
    ['stomach', /\btrao nguoc da day\b|\bloet da day\b|\bloet ta trang\b/],
  ];
  const codes = rules.filter(([, expression]) => positiveMatch(expression)).map(([code]) => code);
  if (category === 'khang-sinh' && positiveMatch(/\bdieu tri\b|\bnhiem khuan\b/))
    codes.push('antibiotic');
  return codes;
}
function safeProductUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === ORIGIN &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      /^\/vi\/san-pham\/[a-z0-9-]+\/[a-z0-9-]+$/.test(url.pathname)
      ? url
      : null;
  } catch {
    return null;
  }
}
async function fetchText(url, fetcher) {
  const response = await fetcher(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(4500),
    headers: { Accept: 'text/html,application/xml' },
  });
  if (!response.ok) throw new Error('Medication source unavailable');
  if (Number(response.headers.get('content-length')) > 1500000)
    throw new Error('Medication source too large');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > 1500000) throw new Error('Medication source too large');
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString('utf8');
}
function createResolver({ fetcher = (...args) => fetch(...args), now = Date.now } = {}) {
  let index = null,
    indexUntil = 0,
    indexPending = null;
  const results = new Map();
  async function loadIndex() {
    if (index && indexUntil > now()) return index;
    if (indexPending) return indexPending;
    indexPending = fetchText(ORIGIN + '/vi/sitemap.xml', fetcher)
      .then((xml) => {
        const urls = [
          ...new Set(
            [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)]
              .map((match) => match[1])
              .filter(safeProductUrl)
          ),
        ];
        if (!urls.length) throw new Error('Medication catalog unavailable');
        index = urls;
        indexUntil = now() + 6 * 60 * 60 * 1000;
        return urls;
      })
      .finally(() => {
        indexPending = null;
      });
    return indexPending;
  }
  async function resolve(name) {
    const query = normalizeName(name);
    if (!query || /^(thuoc|vitamin|thuc pham chuc nang)( |$)/.test(query))
      return { status: 'not_found', tags: [] };
    const cached = results.get(query);
    if (cached?.until > now()) return cached.promise;
    const entry = { until: now() + 6 * 60 * 60 * 1000 };
    entry.promise = (async () => {
      const urls = await loadIndex();
      const candidates = urls.filter((value) => {
        const slug = normalizeName(new URL(value).pathname.split('/').pop());
        return slug === query || slug.replace(/ \d+$/, '') === query;
      });
      if (!candidates.length) return { status: 'not_found', tags: [] };
      if (candidates.length > 3) return { status: 'ambiguous', tags: [] };
      const products = await Promise.all(
        candidates.map(async (url) => {
          const html = await fetchText(url, fetcher);
          const productName = field(html, 'field-field-display-title');
          if (normalizeName(productName) !== query) return null;
          const indications = field(html, 'field-field-n-p-indication');
          const codes = purposeCodes(indications, new URL(url).pathname.split('/')[3]);
          return {
            productName,
            codes,
            source: { name: 'DHG Pharma', url },
            checkedAt: new Date(now()).toISOString(),
          };
        })
      );
      const matches = products.filter(Boolean);
      if (!matches.length) return { status: 'ambiguous', tags: [] };
      if (matches.some((match) => match.codes.join() !== matches[0].codes.join()))
        return { status: 'ambiguous', tags: [] };
      const { codes, ...match } = matches[0];
      return { status: 'matched', tags: codes, ...match };
    })().catch(() => {
      entry.until = now() + 60000;
      return { status: 'unavailable', tags: [] };
    });
    if (results.size >= 256) results.delete(results.keys().next().value);
    results.set(query, entry);
    return entry.promise;
  }
  return { resolve };
}
const resolver = createResolver();
async function lookup(db, actor, patient, body) {
  patient = await c.patientAccess(db, actor, patient);
  await c.assertFeature(db, patient, 'medication');
  const input = inputSchema.parse(body);
  if (input.kind !== 'MEDICINE') return { status: 'not_applicable', tags: [] };
  const result = await resolver.resolve(input.name);
  if (result.status !== 'matched' || !result.tags.length) return result;
  return {
    ...result,
    token: jwt.sign(
      {
        purpose: 'med-purpose-tags',
        actor: Number(actor),
        patient,
        name: nameHash(input.name),
        ...result,
      },
      signingKey(),
      { algorithm: 'HS256', expiresIn: '1h' }
    ),
  };
}
function confirmedTags(actor, patient, item) {
  if (!item.tag_confirmation) return null;
  let match;
  try {
    match = jwt.verify(item.tag_confirmation.token, signingKey(), { algorithms: ['HS256'] });
  } catch {
    throw c.error('MED_TAG_CONFIRMATION_EXPIRED', 409);
  }
  const codes = item.tag_confirmation.codes;
  if (
    item.kind !== 'MEDICINE' ||
    match.purpose !== 'med-purpose-tags' ||
    match.actor !== Number(actor) ||
    match.patient !== Number(patient) ||
    match.name !== nameHash(item.display_name) ||
    !Array.isArray(match.tags) ||
    !codes.every((code) => match.tags.includes(code)) ||
    !safeProductUrl(match.source?.url)
  )
    throw c.error('MED_TAG_CONFIRMATION_INVALID', 400);
  return {
    codes,
    productName: match.productName,
    source: match.source,
    checkedAt: match.checkedAt,
    confirmedAt: new Date().toISOString(),
    confirmedBy: Number(actor),
  };
}
module.exports = {
  lookup,
  confirmedTags,
  confirmationSchema,
  createResolver,
  normalizeName,
  field,
  purposeCodes,
};
