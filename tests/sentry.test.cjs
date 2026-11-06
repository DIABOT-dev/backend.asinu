/* global fetch */
const assert = require('node:assert/strict');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const express = require('express');
const monitorPath = path.resolve(__dirname, '../src/lib/sentry.js');
const monitor = require(monitorPath);
const fakeDsn = 'https://0123456789abcdef@sentry.invalid/123';
const poison = 'PRIVATE_HEALTH_CHAT_AUDIO_PASSWORD_EMAIL_PHONE';

function assertPrivate(envelope) {
  const serialized = JSON.stringify(envelope);
  for (const forbidden of [
    poison,
    'patient@example.invalid',
    'Bearer synthetic-secret',
    '0330000000',
    'rawBody',
    'cookies',
    'pre_context',
    'context_line',
    'audio_url',
    'user_segment',
  ]) {
    assert.ok(!serialized.includes(forbidden), 'telemetry leaked ' + forbidden);
  }
  assert.equal(envelope[0].trace, undefined);
  assert.ok(
    envelope[1].every((item) => item[0].type === 'event'),
    'attachments/transactions must be dropped'
  );
}

test('real Sentry SDK transport: strict privacy, HTTP capture, background tags and disabled fallback', async (t) => {
  const previous = {
    dsn: process.env.SENTRY_DSN,
    enabled: process.env.SENTRY_ENABLED,
    release: process.env.SENTRY_RELEASE,
  };
  delete process.env.SENTRY_DSN;
  delete process.env.SENTRY_ENABLED;
  assert.equal(monitor.initSentry(), false);
  assert.equal(monitor.captureException(new Error(poison)), undefined);
  assert.equal(await monitor.flushSentry(), true);
  process.env.SENTRY_DSN = 'not-a-valid-dsn';
  assert.equal(monitor.initSentry(), false);
  process.env.SENTRY_DSN = fakeDsn;
  process.env.SENTRY_RELEASE = 'asinu-doctor-1234567890abcdef1234567890abcdef12345678';
  const envelopes = [];
  assert.equal(
    monitor.initSentry('asinu-backend', () => ({
      send: (envelope) => {
        envelopes.push(JSON.parse(JSON.stringify(envelope)));
        return Promise.resolve({ statusCode: 200 });
      },
      flush: () => Promise.resolve(true),
    })),
    true
  );
  const Sentry = require('@sentry/node');
  try {
    await t.test(
      'SDK settings disable automatic HTTP/console, tracing, profiling and session payloads',
      () => {
        const opts = Sentry.getClient().getOptions();
        assert.equal(opts.sendDefaultPii, false);
        assert.equal(opts.autoSessionTracking, false);
        assert.equal(opts.tracesSampleRate, 0);
        assert.equal(opts.profilesSampleRate, 0);
        assert.equal(opts.maxBreadcrumbs, 0);
        for (const integration of opts.integrations)
          assert.ok(
            !['Http', 'Console', 'RequestData', 'ContextLines', 'LocalVariables'].includes(
              integration.name
            )
          );
      }
    );
    await t.test(
      'worker exception goes through actual SDK and strips scope plus attachment',
      async () => {
        Sentry.withScope((scope) => {
          scope.setUser({ id: '0330000000', email: 'patient@example.invalid', segment: poison });
          scope.setExtra('audio_url', poison);
          scope.addAttachment({ filename: poison + '.m4a', data: poison });
          const err = new Error(poison);
          err.code = 'ECONNREFUSED';
          monitor.captureException(err, {
            job: 'synthetic_worker',
            tags: { component: 'worker' },
            extra: { health: poison },
            user: poison,
          });
        });
        await monitor.flushSentry();
        assert.equal(envelopes.length, 1);
        assertPrivate(envelopes[0]);
        const event = envelopes[0][1][0][1];
        assert.equal(event.release, 'asinu-doctor-1234567890abcdef1234567890abcdef12345678');
        assert.equal(event.tags.service, 'asinu-backend');
        assert.equal(event.tags.job, 'synthetic_worker');
        assert.equal(event.tags.error_code, 'ECONNREFUSED');
        assert.ok(event.exception.values[0].stacktrace.frames.length);
        assert.equal(event.request, undefined);
        assert.equal(event.user, undefined);
      }
    );
    await t.test(
      'scrubber strips arbitrary fields and exception context, not only known secret keys',
      async () => {
        Sentry.captureEvent({
          exception: {
            values: [
              {
                type: 'Error',
                value: poison,
                mechanism: { type: 'generic', handled: true, data: { health: poison } },
                stacktrace: {
                  frames: [
                    {
                      filename: '/app/src/service.js?token=' + poison,
                      function: 'runFixture',
                      lineno: 12,
                      context_line: poison,
                      pre_context: [poison],
                      vars: { secret: poison },
                    },
                  ],
                },
              },
            ],
          },
          message: poison,
          transaction: poison,
          request: {
            url: 'https://example.invalid/' + poison,
            query_string: poison,
            data: poison,
            headers: { Authorization: 'Bearer synthetic-secret', Cookie: poison },
            cookies: { session: poison },
          },
          contexts: { health: { data: poison } },
          extra: { clinical_text: poison },
          user: { email: 'patient@example.invalid' },
          tags: { health: poison },
          breadcrumbs: [{ message: poison, data: { body: poison } }],
        });
        await monitor.flushSentry();
        assert.equal(envelopes.length, 2);
        assertPrivate(envelopes[1]);
        const event = envelopes[1][1][0][1];
        assert.equal(event.exception.values[0].stacktrace.frames[0].filename, 'app/src/service.js');
        assert.equal(event.exception.values[0].stacktrace.frames[0].lineno, 12);
        assert.equal(event.exception.values[0].value, 'Error');
      }
    );
    await t.test(
      'real Express thrown 500 and caught 503 captured once; 400 not reported',
      async () => {
        const app = express();
        app.use(monitor.sentryRequestHandler());
        app.use(express.json());
        app.post('/throw/:id', (_req, _res, next) => next(new Error(poison)));
        app.post('/caught/:id', (_req, res) => res.status(503).json({ ok: false }));
        app.post('/client/:id', (_req, res) => res.status(400).json({ ok: false }));
        app.use(monitor.sentryErrorHandler());
        app.use((_error, _req, res, _next) => res.status(500).json({ ok: false }));
        const server = app.listen(0, '127.0.0.1');
        await new Promise((resolve) => server.once('listening', resolve));
        try {
          const port = server.address().port;
          for (const [route, status] of [
            ['throw', 500],
            ['caught', 503],
            ['client', 400],
          ]) {
            const response = await fetch(
              'http://127.0.0.1:' +
                port +
                '/' +
                route +
                '/0330000000?patient=patient@example.invalid',
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: 'Bearer synthetic-secret',
                  Cookie: poison,
                },
                body: JSON.stringify({ health: poison }),
              }
            );
            assert.equal(response.status, status);
            await response.text();
          }
          await monitor.flushSentry();
          assert.equal(envelopes.length, 4);
          assert.equal(envelopes[2][1][0][1].tags.route, '/throw/:id');
          assert.equal(envelopes[3][1][0][1].tags.route, '/caught/:id');
          for (const envelope of envelopes) assertPrivate(envelope);
        } finally {
          await new Promise((resolve) => server.close(resolve));
        }
      }
    );
    await t.test('transactions rejected by privacy boundary', () => {
      assert.equal(monitor.sanitizeEvent({ type: 'transaction', transaction: poison }), null);
    });
  } finally {
    await Sentry.close(1000);
    for (const [key, value] of [
      ['SENTRY_DSN', previous.dsn],
      ['SENTRY_ENABLED', previous.enabled],
      ['SENTRY_RELEASE', previous.release],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

for (const kind of ['uncaught', 'rejection']) {
  test('real SDK fatal ' + kind + ' captures sanitized event and exits nonzero', () => {
    const code =
      'const m=require(' +
      JSON.stringify(monitorPath) +
      ');' +
      'm.initSentry("asinu-backend",()=>({send:env=>{process.stdout.write("SENTRY_TEST_ENVELOPE:"+JSON.stringify(env)+"\\n");return Promise.resolve({statusCode:200})},flush:()=>Promise.resolve(true)}));' +
      (kind === 'uncaught'
        ? 'setTimeout(()=>{throw new Error(' + JSON.stringify(poison) + ')},0);'
        : 'Promise.reject(new Error(' + JSON.stringify(poison) + '));');
    const result = spawnSync(process.execPath, ['-e', code], {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, SENTRY_DSN: fakeDsn, SENTRY_ENABLED: 'true' },
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.ifError(result.error);
    assert.notEqual(result.status, 0);
    const line = result.stdout.split('\n').find((line) => line.startsWith('SENTRY_TEST_ENVELOPE:'));
    assert.ok(line, 'fatal handler did not emit event: ' + result.stderr);
    const envelope = JSON.parse(line.slice('SENTRY_TEST_ENVELOPE:'.length));
    assertPrivate(envelope);
    assert.equal(envelope[1][0][1].exception.values[0].mechanism.handled, false);
  });
}
