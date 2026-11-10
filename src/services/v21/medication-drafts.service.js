'use strict';
const c = require('./common');
const med = require('./medication.service');
const p = require('./medication.policy');
const scan = require('./medication-scan.service');
const item = c.z
  .object({
    clientId: c.uuid,
    existingItemId: c.uuid.optional(),
    display_name: c.z.string().max(120).refine(med.noDose),
    printed_name: c.z.string().max(200).refine(med.noDose).optional(),
    kind: c.z.enum(['MEDICINE', 'SUPPLEMENT']).nullable(),
    source: c.z.enum(['PHOTO_AI', 'CHIP', 'VOICE']),
    confirmed: c.z.boolean(),
    photo_media_id: c.uuid.optional(),
    timeHints: c.z
      .array(c.z.enum(['morning', 'noon', 'evening']))
      .max(3)
      .optional(),
    anchors: c.z.array(c.z.enum(p.anchors)).max(5),
    selectedPurposeCodes: c.z.array(c.z.string().max(40)).max(9).optional(),
    purposeLookup: c.z
      .object({
        key: c.z.string().max(200),
        loading: c.z.boolean(),
        version: c.z.number().int().optional(),
        result: c.z
          .object({
            status: c.z.enum([
              'matched',
              'not_found',
              'ambiguous',
              'unavailable',
              'not_applicable',
            ]),
            tags: c.z.array(c.z.string().max(40)).max(9),
            productName: c.z.string().max(200).optional(),
            source: c.z
              .object({ name: c.z.string().max(200), url: c.z.string().url().max(2000) })
              .strict()
              .optional(),
            checkedAt: c.z.string().max(80).optional(),
            token: c.z.string().max(4096).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const snapshotSchema = c.z
  .object({
    version: c.z.literal(1),
    setupFlow: c.z.literal('dose_first').optional(),
    step: c.z.number().int().min(1).max(4),
    items: c.z.array(item).max(20),
    meals: c.z
      .object({
        breakfast: c.z.string().max(5),
        lunch: c.z.string().max(5),
        dinner: c.z.string().max(5),
        bedtime: c.z.string().max(5),
      })
      .strict(),
    slots: c.z
      .array(
        c.z
          .object({
            time_local: c.z.string().max(5),
            meal_anchor: c.z.enum(p.anchors).nullable(),
            item_indexes: c.z.array(c.z.number().int().min(0).max(19)).max(20),
            note: c.z.string().max(1200).refine(med.noDose).optional(),
            sourceKeys: c.z.array(c.z.string().max(100)).max(20).optional(),
          })
          .strict()
      )
      .max(20),
    photoMediaId: c.uuid.nullable(),
  })
  .strict();
async function access(db, actor, patient) {
  patient = await c.patientAccess(db, actor, patient);
  await c.assertFeature(db, patient, 'medication');
  med.requireEncryption();
  return patient;
}
async function read(db, actor, patient) {
  patient = await access(db, actor, patient);
  const load = async () =>
    (
      await db.query(
        "SELECT * FROM med_setup_drafts WHERE actor_id=$1 AND patient_user_id=$2 AND state='ACTIVE' ORDER BY updated_at DESC,id DESC",
        [actor, patient]
      )
    ).rows;
  let rows = await load();
  if (!rows.length) {
    // Recover a pre-draft upload once. A delete/save tombstone prevents old
    // scans from reappearing. This never runs the model or creates med_items.
    await c.transaction(db, async (tx) => {
      await c.lockPatient(tx, patient);
      await access(tx, actor, patient);
      if (
        (
          await tx.query(
            'SELECT 1 FROM med_setup_drafts WHERE actor_id=$1 AND patient_user_id=$2',
            [actor, patient]
          )
        ).rowCount
      )
        return;
      const job = (
        await tx.query(
          `SELECT j.* FROM med_scan_jobs j WHERE j.uploader_id=$1 AND j.patient_user_id=$2
        AND j.status IN('DONE','UNREADABLE') AND j.result_json IS NOT NULL AND j.media_id IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM med_items i WHERE i.photo_media_id=j.media_id)
        ORDER BY j.created_at DESC LIMIT 1`,
          [actor, patient]
        )
      ).rows[0];
      if (!job) return;
      const result = JSON.parse(med.reveal(patient, 'med_scan_jobs.result_json', job.result_json));
      const items = (result.readable !== false && Array.isArray(result.items) ? result.items : [])
        .slice(0, 20)
        .map((i) => ({
          clientId: c.randomUUID(),
          display_name: i.display_name || '',
          printed_name: i.printed_name,
          kind: i.kind || null,
          source: 'PHOTO_AI',
          confirmed: false,
          photo_media_id: job.media_id,
          anchors: (i.suggested_slots || []).filter((x) => p.anchors.includes(x)),
          timeHints: (i.suggested_slots || []).filter((x) =>
            ['morning', 'noon', 'evening'].includes(x)
          ),
        }));
      const meals = (
        await tx.query(
          'SELECT breakfast::text,lunch::text,dinner::text,bedtime::text FROM user_meal_times WHERE user_id=$1',
          [patient]
        )
      ).rows[0] || { breakfast: '06:30', lunch: '11:30', dinner: '18:00', bedtime: '21:30' };
      const snapshot = snapshotSchema.parse({
        version: 1,
        step: items.length ? 2 : 1,
        items,
        meals: Object.fromEntries(
          Object.entries(meals).map(([k, v]) => [k, String(v).slice(0, 5)])
        ),
        slots: [],
        photoMediaId: job.media_id,
      });
      await write(tx, actor, patient, { id: job.id, revision: 0, snapshot });
    });
    rows = await load();
  }
  const drafts = rows.map((row) => {
    const snapshot = snapshotSchema.parse(
      JSON.parse(med.reveal(patient, 'med_setup_drafts.snapshot_json', row.snapshot_json))
    );
    const media = [
      ...new Set(
        [snapshot.photoMediaId, ...snapshot.items.map((x) => x.photo_media_id)].filter(Boolean)
      ),
    ];
    return {
      id: row.id,
      revision: row.revision,
      updatedAt: row.updated_at,
      snapshot,
      photos: Object.fromEntries(media.map((id) => [id, scan.mediaUrl(id, patient, actor)])),
    };
  });
  // Keep the singular field for existing clients that resume the latest draft.
  return { draft: drafts[0] || null, drafts };
}
async function write(pool, actor, patient, body) {
  patient = await access(pool, actor, patient);
  const x = c.z
    .object({ id: c.uuid, revision: c.z.number().int().nonnegative(), snapshot: snapshotSchema })
    .strict()
    .parse(body);
  if (Buffer.byteLength(JSON.stringify(x.snapshot)) > 65536)
    throw c.error('MED_DRAFT_TOO_LARGE', 413);
  return c.transaction(pool, async (db) => {
    await c.lockPatient(db, patient);
    await access(db, actor, patient);
    const old = (
      await db.query(
        'SELECT * FROM med_setup_drafts WHERE id=$1 AND actor_id=$2 AND patient_user_id=$3 FOR UPDATE',
        [x.id, actor, patient]
      )
    ).rows[0];
    if (
      old?.id === x.id &&
      old.state === 'ACTIVE' &&
      old.revision === x.revision + 1 &&
      med.reveal(patient, 'med_setup_drafts.snapshot_json', old.snapshot_json) ===
        JSON.stringify(x.snapshot)
    )
      return { id: old.id, revision: old.revision };
    if (old && (old.state !== 'ACTIVE' || old.revision !== x.revision))
      throw c.error('MED_DRAFT_CHANGED', 409);
    if (!old && x.revision !== 0) throw c.error('MED_DRAFT_CHANGED', 409);
    const media = [
      ...new Set(
        [x.snapshot.photoMediaId, ...x.snapshot.items.map((i) => i.photo_media_id)].filter(Boolean)
      ),
    ];
    if (
      media.length &&
      (
        await db.query('SELECT id FROM med_media WHERE id=ANY($1::uuid[]) AND patient_user_id=$2', [
          media,
          patient,
        ])
      ).rowCount !== media.length
    )
      throw c.error('MED_DRAFT_MEDIA_DENIED', 403);
    const revision = old?.id === x.id ? old.revision + 1 : 1;
    const payload = med.protect(
      patient,
      'med_setup_drafts.snapshot_json',
      JSON.stringify(x.snapshot)
    );
    if (old)
      await db.query(
        'UPDATE med_setup_drafts SET revision=$2,snapshot_json=$3,updated_at=NOW() WHERE id=$1',
        [x.id, revision, payload]
      );
    else
      await db.query(
        `INSERT INTO med_setup_drafts(id,actor_id,patient_user_id,revision,state,snapshot_json)
      VALUES($1,$2,$3,$4,'ACTIVE',$5)`,
        [x.id, actor, patient, revision, payload]
      );
    return { id: x.id, revision };
  });
}
async function remove(pool, actor, patient, id, revision) {
  patient = await access(pool, actor, patient);
  c.uuid.parse(id);
  revision = c.z.coerce.number().int().positive().parse(revision);
  return c.transaction(pool, async (db) => {
    await c.lockPatient(db, patient);
    await access(db, actor, patient);
    const row = (
      await db.query(
        'SELECT * FROM med_setup_drafts WHERE id=$1 AND actor_id=$2 AND patient_user_id=$3 FOR UPDATE',
        [id, actor, patient]
      )
    ).rows[0];
    if (!row || row.id !== id) throw c.error('MED_DRAFT_CHANGED', 409);
    if (row.state === 'DELETED') return { removed: true };
    if (row.state !== 'ACTIVE' || row.revision !== revision)
      throw c.error('MED_DRAFT_CHANGED', 409);
    await db.query(
      "UPDATE med_setup_drafts SET state='DELETED',snapshot_json=NULL,revision=revision+1,updated_at=NOW() WHERE id=$1",
      [id]
    );
    return { removed: true };
  });
}
module.exports = { read, write, remove, snapshotSchema };
