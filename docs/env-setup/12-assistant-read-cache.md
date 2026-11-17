# Device cache for approved agent reads

The mobile app keeps up to eight signed read plans per account in OS-protected
SecureStore. Records are split into bounded chunks and expire after 15 minutes.
Logout, account/session changes and clearing the agent conversation remove the
stored plans. Raw health answers and executable action tokens are not cached by
this feature.

The first supported read follows the normal agent planning and independent
review. An answer-only result may include `readCache: {token, key, expiresAt}`.
For an identical context-independent request, the app submits that capability to
`POST /api/mobile/assistant/read-cache`. The backend verifies the current user,
consent, signature, request fingerprint, model/prompt/schema policy, calendar day
and expiry, then reads current data and permissions in a read-only transaction.
This replay makes no model request. It keeps the original expiry.

The fingerprint includes trimmed request text, language, font size, sorted unique
hidden article IDs and curated-article visibility. Follow-ups requiring prior
conversation or clarification do not receive cache capabilities. A changed
fingerprint or HTTP409 `APP_ASSISTANT_READ_CACHE_MISS` triggers normal planning.
Authentication, permission, consent and transport failures propagate without
starting an additional AI request.

Only explicitly audited read tools and plain queries are eligible. Writes,
mixed operations, navigation, speech, native actions, signed executable previews
and legacy reads that can mutate data remain on the normal path. In particular,
missions, current coin balance and daily gifts are excluded. No database migration
or new dependency is required.

Validation:

```sh
# Backend
npx jest --runInBand tests/unit/assistant-read-cache.test.js tests/unit/assistant-read-cache-http.test.js
node scripts/probe-assistant-read-cache.cjs

# Mobile repository
npm run test:assistant-read-cache
npm run type-check
npm run test:api-contract
```

The live probe uses fixed synthetic notifications and a fake read-only database.
It calls the real configured 9Router for initial planning/review, changes the
synthetic data, and verifies that replay returns the new value with zero extra
model calls. It does not access patient records or apply real actions.
