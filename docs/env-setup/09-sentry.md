# Sentry error monitoring

Use Sentry Cloud; each VPS runs only the Node SDK. Keep the existing v7.120.4-compatible error API for this rollout. A major SDK upgrade needs its own instrumentation/privacy review.

## Runtime configuration

Set these privately in the runtime environment, never in Git:

- SENTRY_DSN: project DSN from Sentry Settings / Client Keys.
- SENTRY_ENVIRONMENT: production.
- SENTRY_RELEASE: service name + deployed Git SHA (letters, digits, hyphen, period, underscore).
- SENTRY_ENABLED=false: optional kill switch, telemetry disabled without stopping the application.

Missing or invalid DSN disables monitoring without blocking startup. Compose env_file already forwards the private .env. Recreate containers after changing environment; docker compose restart does not reload values.

Prefer separate Sentry projects, or share an existing DSN and filter fixed service tags: asinu-backend, doctor-backend, crm-api, crm-worker. API and worker containers each need the DSN. CRM worker bootstrap sets its own service tag independent of environment. Set a release per artifact.

## Capture and privacy

Sentry starts before business modules. Uncaught exceptions and unhandled rejections are captured before a nonzero process exit. Thrown HTTP 5xx errors and caught 5xx responses are reported once; expected 4xx responses are excluded. Existing cron/worker/payment failures are connected to error capture.

Only error type, technical error code, stack file/function/line and a small allowlist of technical tags are sent. Raw exception messages are intentionally replaced because SQL errors and provider messages may contain health text. Request bodies, raw URLs, query strings, headers, cookies, users, arbitrary context/extra, console breadcrumbs, source context, locals, audio and attachments are never sent. The envelope guard also removes sampling context.

Tracing, profiling, automatic sessions and console/HTTP/DB instrumentation are disabled by policy. Existing SENTRY_TRACES_SAMPLE_RATE and SENTRY_PROFILES_SAMPLE_RATE values are intentionally ignored. This is application error monitoring; CPU/RAM/disk and missed-job detection still need infrastructure/uptime monitors.

## Verification and deployment

1. npm run test:sentry uses the real SDK and in-memory transport: disabled/invalid configuration, strict scope/error/attachment redaction, real Express 4xx/5xx, job tags, and fatal/rejection subprocesses. No network or real patient data is used. This runs as part of npm test too.
2. Build/release the backend. Doctor/CRM compile src/instrumentation.ts and src/observability/sentry.ts to dist; CRM worker also needs dist/worker-instrumentation.js. Doctor/CRM require @sentry/node7.120.4 plus its resolved dependencies from package-lock. Asinu already has this SDK. No database migration is needed.
3. Supply runtime env and recreate the affected containers. Keep the previous image and private env available for rollback.
4. Run npm run sentry:smoke inside the deployed container (Doctor/CRM must have compiled dist first). It sends one synthetic SentryDeploymentCheckError with operation:deployment_check and prints only event ID plus transport status. No public debug route is installed. For CRM worker smoke, set SENTRY_SERVICE=crm-worker when running the command; runtime worker bootstrap already uses this tag.
5. Configure new-issue/regression alerts in the Sentry project, production environment, and verify recipient delivery. Successful SDK ingestion does not configure alert rules or email recipients.

Rollback by restoring the previous image, or recreate with SENTRY_ENABLED=false. Changes do not alter patient data or task/check-in behavior.
