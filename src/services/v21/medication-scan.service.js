'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  jwt = require('jsonwebtoken');
const c = require('./common'),
  med = require('./medication.service');
const { assertAiConsent, mayProcessAi } = require('../ai/ai-consent.service');
const { isSupportedPatientFile } = require('../media/private-media.service');
const NAME_STRENGTH = /\b\d+(?:[.,]\d+)?\s*(?:mg|mcg|µg|ml|iu|g)\b/giu;
const cleanName = (value) =>
  String(value || '')
    .replace(NAME_STRENGTH, '')
    .replace(/\s+/g, ' ')
    .trim();
function normalizeScan(raw) {
  const obj = JSON.parse(
    String(raw)
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
  );
  if (!obj || !Array.isArray(obj.items) || obj.items.length > 20)
    throw c.error('MED_SCAN_UNREADABLE', 422);
  const documentType = ['PACKAGING', 'PRESCRIPTION', 'OTHER'].includes(obj.document_type)
    ? obj.document_type
    : 'OTHER';
  const seen = new Set(),
    items = [];
  for (const original of obj.items) {
    if (!original || typeof original.printed_name !== 'string') continue;
    const printed = cleanName(original.printed_name);
    if (!printed || printed.length > 120 || !med.noDose(printed)) continue;
    const key = printed.toLocaleLowerCase('vi');
    if (seen.has(key)) continue;
    seen.add(key);
    const display = cleanName(original.display_name || printed);
    // A long or incomplete name needs explicit editing; never cut a drug name.
    const displayName = display.length <= 30 && med.noDose(display) ? display : null;
    const slots =
      documentType === 'PRESCRIPTION' && Array.isArray(original.suggested_slots)
        ? original.suggested_slots.filter((x) =>
            [
              'morning',
              'noon',
              'evening',
              'bedtime',
              'before_breakfast',
              'after_breakfast',
              'after_lunch',
              'after_dinner',
            ].includes(x)
          )
        : [];
    items.push({
      printed_name: printed,
      display_name: displayName,
      kind: ['MEDICINE', 'SUPPLEMENT'].includes(original.kind) ? original.kind : null,
      suggested_slots: [...new Set(slots)],
      needs_name_review: !displayName,
      confirmed: false,
    });
  }
  return {
    readable: items.length > 0,
    document_type: documentType,
    items,
    ...(Array.isArray(obj.uncertain) && obj.uncertain.length ? { partial: true } : {}),
  };
}
function signingKey() {
  if (!process.env.JWT_SECRET) throw c.error('MED_MEDIA_UNAVAILABLE', 503);
  return process.env.MED_MEDIA_SIGNING_KEY || process.env.JWT_SECRET;
}
function mediaUrl(id, patient, viewer) {
  return `/api/mobile/med-media/${id}?token=${jwt.sign({ purpose: 'med-photo', media: id, patient: Number(patient), viewer: Number(viewer) }, signingKey(), { expiresIn: 300, algorithm: 'HS256' })}`;
}
async function readMedia(db, id, token) {
  c.uuid.parse(id);
  let claims;
  try {
    claims = jwt.verify(token, signingKey(), { algorithms: ['HS256'] });
  } catch {
    throw c.error('MED_MEDIA_EXPIRED', 401);
  }
  if (claims.purpose !== 'med-photo' || claims.media !== id)
    throw c.error('MED_MEDIA_EXPIRED', 401);
  await c.patientAccess(db, claims.viewer, claims.patient);
  if (
    !(await db.query('SELECT 1 FROM users WHERE id=$1 AND deleted_at IS NULL', [claims.viewer]))
      .rowCount
  )
    throw c.error('MED_MEDIA_EXPIRED', 401);
  med.requireEncryption();
  const row = (
    await db.query('SELECT * FROM med_media WHERE id=$1 AND patient_user_id=$2', [
      id,
      claims.patient,
    ])
  ).rows[0];
  if (!row) throw c.error('MED_PHOTO_NOT_FOUND', 404);
  return {
    buffer: Buffer.from(
      med.reveal(row.patient_user_id, 'med_media.payload', row.payload),
      'base64'
    ),
    mimeType: row.mime_type,
  };
}
async function scan(pool, actor, patient, file) {
  patient = await c.patientAccess(pool, actor, patient);
  await c.assertFeature(pool, patient, 'scan');
  med.requireEncryption();
  await assertAiConsent();
  if (Number(actor) !== patient && !(await mayProcessAi(pool, patient)))
    throw c.error('MED_PATIENT_AI_CONSENT_REQUIRED', 403);
  if (
    !file?.buffer ||
    file.buffer.length > 10485760 ||
    !isSupportedPatientFile(file.buffer, file.mimetype) ||
    !file.mimetype.startsWith('image/')
  )
    throw c.error('MED_IMAGE_INVALID', 400);
  if (
    (
      await pool.query(
        "SELECT count(*)::int n FROM med_scan_jobs WHERE uploader_id=$1 AND created_at>NOW()-INTERVAL '1 hour'",
        [actor]
      )
    ).rows[0].n >= 20
  )
    throw c.error('MED_SCAN_LIMIT', 429);
  const mediaId = c.randomUUID(),
    jobId = c.randomUUID();
  await c.transaction(pool, async (db) => {
    await db.query(
      'INSERT INTO med_media(id,patient_user_id,uploader_id,mime_type,payload,byte_length) VALUES($1,$2,$3,$4,$5,$6)',
      [
        mediaId,
        patient,
        actor,
        file.mimetype,
        med.protect(patient, 'med_media.payload', file.buffer.toString('base64')),
        file.buffer.length,
      ]
    );
    await db.query(
      "INSERT INTO med_scan_jobs(id,uploader_id,patient_user_id,media_id,status) VALUES($1,$2,$3,$4,'PROCESSING')",
      [jobId, actor, patient, mediaId]
    );
  });
  let result, model;
  try {
    const endpoint = new URL(process.env.MEDGEMMA_ENDPOINT || '');
    model = process.env.MED_SCAN_MODEL || 'med-gemini';
    if (
      (process.env.AI_PROVIDER_CLINICAL || 'medgemma') !== 'medgemma' ||
      endpoint.protocol !== 'https:' ||
      endpoint.hostname !== 'dr7.ai' ||
      !process.env.MEDGEMMA_API_KEY
    )
      throw c.error('MED_SCAN_PROVIDER_UNAVAILABLE', 503);
    const prompt = fs.readFileSync(path.join(__dirname, 'medication-scan.prompt.txt'), 'utf8');
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + process.env.MEDGEMMA_API_KEY,
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              {
                type: 'image_url',
                image_url: {
                  url: `data:${file.mimetype};base64,${file.buffer.toString('base64')}`,
                },
              },
            ],
          },
        ],
        temperature: 0.1,
        max_tokens: 1800,
      }),
      signal: AbortSignal.timeout(45000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw c.error('MED_SCAN_UNAVAILABLE', 503);
    }
    const data = await response.json();
    if (data.model !== model) throw c.error('MED_SCAN_MODEL_MISMATCH', 503);
    result = normalizeScan(data.choices?.[0]?.message?.content || '');
    await pool.query('UPDATE med_scan_jobs SET status=$2,result_json=$3,model=$4 WHERE id=$1', [
      jobId,
      result.readable ? 'DONE' : 'UNREADABLE',
      med.protect(patient, 'med_scan_jobs.result_json', JSON.stringify(result)),
      model,
    ]);
  } catch {
    await pool.query("UPDATE med_scan_jobs SET status='FAILED',model=$2 WHERE id=$1", [
      jobId,
      model || null,
    ]);
    // Keep only the encrypted image for a user's manual chip confirmation.
    return {
      jobId,
      mediaId,
      photoUrl: mediaUrl(mediaId, patient, actor),
      readable: false,
      items: [],
      manualFallback: true,
    };
  }
  return { jobId, mediaId, photoUrl: mediaUrl(mediaId, patient, actor), ...result };
}
module.exports = { scan, normalizeScan, cleanName, mediaUrl, readMedia };
