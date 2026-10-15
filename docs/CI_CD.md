# ASINU backend CI/CD

## CI

`Backend CI` runs on pull requests and pushes to `main`. It:

- Runs ESLint.
- Reports the existing Prettier baseline as an advisory check.
- Starts PostgreSQL 14 and applies every migration.
- Runs the complete Jest suite, including check-in call integration tests.
- Builds the production Docker image.

## CD

After `Backend CI` succeeds on `main`, `Backend CD` publishes two GHCR tags:

- `ghcr.io/diabot-dev/backend.asinu:<full-commit-sha>`
- `ghcr.io/diabot-dev/backend.asinu:main`

Deployment is manual by default. Set the repository variable `AUTO_DEPLOY_CAMP=true` to deploy Camp automatically after a successful `main` CI run.

Create GitHub environments named `camp` and `prod`. Configure each environment with:

### Secrets

- `VPS_HOST`
- `VPS_USER`
- `VPS_SSH_KEY`
- `GHCR_PULL_TOKEN` (optional; the workflow token is used when omitted)

### Variables

- `STACK_DIR` (default `/opt/asinu-backend`)
- `HOST_PORT` (default `3300`)
- `BASE_URL` (optional external URL used for the final smoke test)

The target VPS must have Docker Compose, a runtime `.env`, a separate `.env.migrations`, and the readable CA file referenced by `DB_TLS_CA_HOST_FILE` inside the deployment configuration. The workflow runs a one-off migration container before starting the API with its restricted runtime role; administrator credentials are never passed to the API. A failed health check restores the previous image when one exists. The previous image must support verified database TLS and the restricted runtime role; for the first security rollout retain the original deployment configuration as a separate recovery path. See `docs/DEPLOY.md` for provisioning, encrypted backups, and recovery prerequisites.
