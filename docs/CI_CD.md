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

The target VPS must have Docker Compose and a production `.env` file inside `STACK_DIR`. The container runs migrations before starting the API. A failed health check restores the previous image when one exists.
