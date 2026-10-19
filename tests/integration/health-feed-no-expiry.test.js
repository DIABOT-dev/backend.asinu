'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { databaseOptions } = require('../../src/lib/database-options');
const repo = require('../../src/services/health_feed/repository');

const url = process.env.CHECKIN_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite('Health Feed without expiry, isolated PostgreSQL fixtures', () => {
  let db;
  let originalRows;
  const migration = fs.readFileSync(
    path.join(__dirname, '../../db/migrations/114_health_feed_no_expiry.sql'),
    'utf8'
  );

  beforeAll(async () => {
    db = new Client({ ...databaseOptions(url), options: '-c statement_timeout=5000' });
    await db.connect();
    await db.query('BEGIN');
    // Shadow every table read by the real repository. Production rows and
    // sequences are never changed; the transaction drops all TEMP fixtures.
    for (const table of [
      'users',
      'user_onboarding_profiles',
      'user_lifecycle',
      'user_baselines',
      'user_notification_preferences',
      'problem_clusters',
      'script_sessions',
      'user_connections',
      'medication_adherence',
      'user_engagement',
      'health_feed_user_flow',
      'health_feed_notification_jobs',
      'notifications',
      'health_feed_content_items',
      'health_feed_feed_items',
    ]) {
      await db.query(
        `CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING ALL) ON COMMIT DROP`
      );
    }
    await db.query('ALTER TABLE health_feed_feed_items ALTER COLUMN expires_at SET NOT NULL');
    await db.query(
      "INSERT INTO users (id, display_name) VALUES (1,'Fixture one'),(2,'Fixture two'),(3,'Fixture three')"
    );
    for (const id of ['old-unread', 'old-read', 'old-dismissed', 'other-account', 'new-item']) {
      await db.query(
        `INSERT INTO health_feed_content_items (id,title,body,target_flow)
        VALUES ($1,$1,$1,'FLOW_NURTURE')`,
        [id]
      );
    }
    await db.query(`INSERT INTO health_feed_feed_items
      (user_id,content_id,feed_type,title,message,created_at,read_at,dismissed_at,expires_at)
      VALUES
      (1,'old-unread','article','Unread','Unread','2000-01-01',NULL,NULL,'2000-01-08'),
      (1,'old-read','article','Read','Read','2000-01-01','2000-01-02',NULL,'2000-01-08'),
      (1,'old-dismissed','article','Dismissed','Dismissed','2000-01-01',NULL,'2000-01-03','2000-01-08'),
      (2,'other-account','article','Private','Private','2000-01-01',NULL,NULL,'2000-01-08')`);
    originalRows = (await db.query('SELECT * FROM health_feed_feed_items ORDER BY id')).rows;
    await db.query(migration);
  });

  afterAll(async () => {
    if (db) {
      await db.query('ROLLBACK');
      await db.end();
    }
  });

  test('restores expired records while preserving every other stored field, including read and dismissed dates', async () => {
    const rows = (await db.query('SELECT * FROM health_feed_feed_items ORDER BY id')).rows;
    expect(rows).toEqual(originalRows.map((row) => ({ ...row, expires_at: null })));
    await db.query(migration);
    expect((await db.query('SELECT * FROM health_feed_feed_items ORDER BY id')).rows).toEqual(rows);
  });

  test('old unread and read items remain visible, while dismissed and other accounts’ items stay hidden', async () => {
    const items = await repo.listFeed(db, 1);
    expect(items.map((item) => item.content_id).sort()).toEqual(['old-read', 'old-unread']);
    expect(items.find((item) => item.content_id === 'old-read').read_at).toBeInstanceOf(Date);
    expect(items.every((item) => item.expires_at === null)).toBe(true);
  });

  test('context selection also keeps old undismissed items active', async () => {
    const [context] = await repo.getUserContexts(db, [1]);
    expect(context.active_feed.map((item) => item.content_id).sort()).toEqual([
      'old-read',
      'old-unread',
    ]);
  });

  test('new items have no expiry and repeated delivery never duplicates them', async () => {
    const user = { id: 3, language_preference: 'vi', related_patients: [] };
    const selected = [
      {
        flow: 'FLOW_NURTURE',
        patient_id: null,
        content: {
          id: 'new-item',
          title: 'New',
          summary: 'New reminder',
          body: 'New reminder',
          content_type: 'article',
        },
      },
    ];
    const inserted = await repo.insertFeedItems(db, user, selected);
    expect(inserted).toHaveLength(1);
    expect(inserted[0].expires_at).toBeNull();
    expect(await repo.insertFeedItems(db, user, selected)).toEqual([]);
    expect(await repo.listFeed(db, 3)).toHaveLength(1);
  });

  test('users can still dismiss restored items and cannot dismiss another account’s item', async () => {
    const [item] = await repo.listFeed(db, 2);
    expect(await repo.dismiss(db, 1, item.id)).toBe(false);
    expect(await repo.listFeed(db, 2)).toHaveLength(1);
    expect(await repo.dismiss(db, 2, item.id)).toBe(true);
    expect(await repo.listFeed(db, 2)).toEqual([]);
  });
});
