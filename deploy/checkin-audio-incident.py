"""Read-only incident snapshot; only encrypted output leaves the VPS."""
import base64
import gzip
import json
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

CERTIFICATE = '-----BEGIN CERTIFICATE-----\nMIIEPzCCAqegAwIBAgIUX76x83wRUQtcq2U7eypF4tn1PmEwDQYJKoZIhvcNAQEL\nBQAwLzEtMCsGA1UEAwwkQXNpbnUgdGVtcG9yYXJ5IGluY2lkZW50IGRpYWdub3N0\naWNzMB4XDTI2MTEwNjA3MDMzOVoXDTI2MTEwODA3MDMzOVowLzEtMCsGA1UEAwwk\nQXNpbnUgdGVtcG9yYXJ5IGluY2lkZW50IGRpYWdub3N0aWNzMIIBojANBgkqhkiG\n9w0BAQEFAAOCAY8AMIIBigKCAYEAvotNkmgN2f5ANfpEIXd4yqsYOQD5F0mBJNI+\nS4W3QRSkJLBzRR2eRNdHUgsgQr+3wHzW3arhwOULhdjW5Ij9OAMM8R6kIPKqCIFw\nAm4PDBqNwDlv2TszFyUZAVNuTZxnAQSVSMH6AgJqcKqyI+WcDW2thVgot8ZuBbgK\nKPkqSXp/6EmPFtmcFfQYN2bTseBWwGCAlKmueH5rdPhVyYAr8cyoGeDd4gNEzW1y\nyHYgPOYqI0uHenfLAxNEsWhXtXVmfe0w5xnXoXLZCB3et8AwXXrbNG4d0I9eh/B1\nZJM5nLk3sG5uAxO6D+Ul1Ek4dRB3BdDaqgeZeHGOlX0NBu5r5azoEmhqssTDwNcR\nmrnxtvtn8luT+NevHSPQb9H5zwPyKrU3mOfQ5ztzMZtkt37HbfjyFCsBp7M4A8Qm\nL50B1QiFRCCAKtl6EidaiO6niE/3y68LTonh+JJpLILYM7x6q3dv1E07UjZO6/G3\nXvOlTLVVGr73p5SmUpA7I/mZkBL3AgMBAAGjUzBRMB0GA1UdDgQWBBSnpzSAx49u\nHhVkFO5rttv6IUcASDAfBgNVHSMEGDAWgBSnpzSAx49uHhVkFO5rttv6IUcASDAP\nBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBgQBJDbTjg4jyUaLRI61U\n3niFwR3RXJRWlg/DlB0JmPDXRNXpSaAz5T9hYrOR9WtRzeV6xRcy6jdq3bBeXlrK\nNYVl3sga8yXRBltSMG9xcmPHK8tZULzH3ulgK9zXkY5PF5oWrgkV9ch5Rsa0/Apz\noW98GBgRX8F2m5Eb42Dv7j04iD9yjO2coRXIiAvTJ2/AxwY98hTUWoa7ldLw8+0j\nFray6Doivh4KiQmP5Nqbs9n0rdz/hSN7Mpcdv8XvmzRYsY49/5/XtSs6oH8tlosv\nkZqMQvhPsOU0nkFiKbyXwvVm2hZHHXC6A8H1vjchWztnc7CbcYP+XWrIBvA1Wvd8\nKwHjCrOnOZtzd6yY0PdUKF0OpGTpeb1aa5a/tYoTkNzNjArmloee3h+spHGDTTZI\nxJ+pjU8FHbunQFxN1K9IhteMxd0DWbE9BL9Bswrcq702iS1xNIPFGi4x/gzCqnck\nFxwwlsj5sLHZ9M6yrxIOzNpoZz9iz+spdpcAp6JhXADHICc=\n-----END CERTIFICATE-----\n'


def run(args, input=None, timeout=35):
    try:
        result = subprocess.run(args, input=input, capture_output=True, text=True, timeout=timeout)
        return {"status": result.returncode, "stdout": result.stdout, "stderr": result.stderr}
    except subprocess.TimeoutExpired:
        return {"status": "timeout"}


phone = base64.b64decode(sys.argv[1], validate=True).decode()
if not re.fullmatch(r"\+?[0-9]{9,13}", phone):
    raise SystemExit("Invalid incident lookup")

node = r"""
const { Client } = require('pg');
const { databaseOptions } = require('./src/lib/database-options');
const { createHash } = require('node:crypto');
const client = new Client({ ...databaseOptions(process.env.DATABASE_URL), connectionTimeoutMillis: 8000, statement_timeout: 10000 });
const result = { audioConfig: {
  voice: process.env.VIENEU_VOICE || null,
  apiKeyConfigured: Boolean(process.env.VIENEU_API_KEY),
  timeoutMs: process.env.VIENEU_TIMEOUT_MS || null,
  format: process.env.CHECKIN_CALL_AUDIO_FORMAT || null,
  revision: process.env.CHECKIN_CALL_AUDIO_REVISION || null,
  consentEnforced: process.env.AI_CONSENT_ENFORCEMENT || null,
}};
async function read(label, sql, params = []) {
  try { result[label] = (await client.query(sql, params)).rows; }
  catch (error) { result[label] = { error: error.message, code: error.code }; }
}
(async () => {
  await client.connect();
  await client.query('SET default_transaction_read_only = on');
  await read('serverTime', 'SELECT now() AS now');
  await read('consentStorage', "SELECT current_database() AS db, current_user AS role, has_table_privilege(current_user, 'user_ai_consents', 'INSERT') AS can_insert, has_table_privilege(current_user, 'user_ai_consents', 'UPDATE') AS can_update, has_table_privilege(current_user, 'user_ai_consents', 'SELECT') AS can_select, (SELECT relrowsecurity FROM pg_class WHERE oid = 'user_ai_consents'::regclass) AS rls, (SELECT count(*)::int FROM user_ai_consents) AS receipts");
  await read('account', "SELECT id FROM users WHERE deleted_at IS NULL AND right(regexp_replace(coalesce(phone_number,''),'[^0-9]','','g'),9) = $1", [process.env.INCIDENT_PHONE.slice(-9)]);
  if (Array.isArray(result.account) && result.account.length === 1) {
    const userId = result.account[0].id;
    await read('aiConsent', 'SELECT version, providers, granted_at, revoked_at FROM user_ai_consents WHERE user_id = $1', [userId]);
    try {
      const consent = require('./src/services/ai/ai-consent.service');
      result.mayProcessAi = await consent.mayProcessAi(client, userId);
      try { await consent.assertAiConsent(); result.unscopedConsentCheck = 'allowed'; }
      catch (error) { result.unscopedConsentCheck = error.code || error.message; }
      try { await consent.withAiUser(client, userId, () => consent.assertAiConsent()); result.scopedConsentCheck = 'allowed'; }
      catch (error) { result.scopedConsentCheck = error.code || error.message; }
    } catch (error) { result.consentCheckError = error.message; }
    await read('settings', 'SELECT * FROM checkin_call_settings WHERE user_id = $1', [userId]);
    await read('voicePreferences', 'SELECT preferences, updated_at FROM checkin_call_voice_preferences WHERE user_id = $1', [userId]);
    await read('episodes', "SELECT id, state, trigger_source, severity, created_at, updated_at, scheduled_at, next_action_at, resolved_at, exhausted_at, config->>'test_mode' AS test_mode FROM checkin_call_episodes WHERE user_id = $1 ORDER BY created_at DESC LIMIT 6", [userId]);
    await read('attempts', 'SELECT a.* FROM checkin_call_attempts a JOIN checkin_call_episodes e ON e.id = a.episode_id WHERE (e.user_id = $1 OR a.target_user_id = $1) AND a.created_at > now() - interval \'24 hours\' ORDER BY a.created_at DESC LIMIT 20', [userId]);
    await read('events', 'SELECT v.event, v.episode_id, v.attempt_id, v.detail, v.created_at FROM checkin_call_events v JOIN checkin_call_episodes e ON e.id = v.episode_id WHERE e.user_id = $1 AND v.created_at > now() - interval \'24 hours\' ORDER BY v.created_at DESC LIMIT 100', [userId]);
    await read('deliveries', 'SELECT d.kind, d.state, d.tries, d.last_error, d.created_at, d.updated_at, d.attempt_id FROM checkin_call_deliveries d JOIN checkin_call_episodes e ON e.id = d.episode_id WHERE e.user_id = $1 AND d.created_at > now() - interval \'24 hours\' ORDER BY d.created_at DESC LIMIT 30', [userId]);
    await read('subscriptionSchema', "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('user_subscriptions', 'subscriptions', 'subscription_plans') ORDER BY table_name, ordinal_position");
  }
  await read('audioCache', "SELECT audio_key, text_hash, mime_type, octet_length(audio_data) AS bytes, encode(substring(audio_data from 1 for 16),'hex') AS header, created_at FROM checkin_call_audio ORDER BY audio_key");
  try {
    const audio = require('./src/services/checkin-call/audio.service');
    result.expectedAudioVersion = { vi: audio.audioVersion('vi'), en: audio.audioVersion('en') };
    result.expectedAudioMime = audio.audioMimeType('vi');
  } catch (error) { result.audioVersionError = error.message; }
})().catch(error => { result.error = error.message; }).finally(async () => {
  await client.end().catch(() => {});
  console.log(JSON.stringify(result));
});
"""
node_input = 'process.env.INCIDENT_PHONE = ' + json.dumps(phone) + ';\n' + node
snapshot = {
    "at": datetime.now(timezone.utc).isoformat(),
    "containers": run(["docker", "ps", "--format", "{{.Names}} {{.Image}} {{.Status}}"]),
    "database": run(["docker", "exec", "-i", "asinu-backend", "node"], input=node_input, timeout=65),
}
logs = run(["docker", "logs", "--timestamps", "--since", "90m", "--tail", "9000", "asinu-backend"])
snapshot["backendLogs"] = "\n".join(
    line for line in (logs.get("stdout", "") + "\n" + logs.get("stderr", "")).splitlines()
    if re.search(r"checkin.?call|vieneu|tts|audio|error|warn|native|livekit|consent", line, re.I)
)[-650000:]
snapshot["nginxAccess"] = run(["sh", "-c", "tail -n 12000 /var/log/nginx/access.log 2>/dev/null | grep -E 'checkin-call|checkin/call' | tail -n 400"])
snapshot["proxyConfig"] = run(["docker", "exec", "asinu-public-proxy", "cat", "/etc/caddy/Caddyfile"])
proxy_logs = run(["docker", "logs", "--timestamps", "--since", "90m", "--tail", "5000", "asinu-public-proxy"])
snapshot["proxyLogs"] = "\n".join(line for line in (proxy_logs.get("stdout", "") + "\n" + proxy_logs.get("stderr", "")).splitlines() if re.search(r"ai-consent|checkin-call|error", line, re.I))[-200000:]
for container in snapshot["containers"].get("stdout", "").splitlines():
    name = container.split()[0]
    if "livekit" in name.lower():
        snapshot["livekit:" + name] = run(["docker", "logs", "--timestamps", "--since", "90m", "--tail", "500", name])

with tempfile.TemporaryDirectory(prefix="asinu-incident-") as directory:
    directory = Path(directory)
    certificate = directory / "recipient.pem"
    certificate.write_text(CERTIFICATE)
    source = directory / "snapshot.json.gz"
    source.write_bytes(gzip.compress(json.dumps(snapshot).encode()))
    encrypted = directory / "snapshot.cms"
    subprocess.run(["openssl", "cms", "-encrypt", "-aes-256-cbc", "-binary", "-outform", "DER", "-in", str(source), "-out", str(encrypted), str(certificate)], check=True, capture_output=True)
    value = base64.b64encode(encrypted.read_bytes()).decode()
    for start in range(0, len(value), 6000):
        print("SECURE_CHECKIN_DIAG:" + value[start:start + 6000])
