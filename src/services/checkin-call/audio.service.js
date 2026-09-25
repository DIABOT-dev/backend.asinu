const { createHash } = require('crypto');
const { t } = require('../../i18n');

const AUDIO_KEYS = Object.freeze([
  'user_prompt',
  'user_ok',
  'user_mild',
  'user_urgent',
  'user_retry',
  'family_mild',
  'family_urgent',
  'family_unknown',
]);

const PHRASES = Object.freeze(
  Object.fromEntries(
    AUDIO_KEYS.map((key) => [
      key,
      Object.freeze({
        vi: t('checkinCall.audio.' + key, 'vi'),
        en: t('checkinCall.audio.' + key, 'en'),
      }),
    ])
  )
);

function normalizeLanguage(value) {
  return String(value || '')
    .toLowerCase()
    .startsWith('en')
    ? 'en'
    : 'vi';
}

function audioError(message, statusCode, i18nKey) {
  return Object.assign(new Error(message), { statusCode, i18nKey });
}

async function getAudio(pool, key, requestedLanguage = 'vi') {
  const language = normalizeLanguage(requestedLanguage);
  const phrase = PHRASES[key]?.[language];
  if (!phrase) throw audioError('Unknown audio key', 404, 'checkinCall.error.unknown_audio');
  const voice =
    language === 'en' ? process.env.VIENEU_VOICE_EN : process.env.VIENEU_VOICE || 'Ngọc Lan';
  // Do not synthesize English with a Vietnamese-only voice. The app will use
  // its en-US system voice until an English-capable backend voice is configured.
  if (!voice)
    throw audioError(
      'English TTS voice is not configured',
      503,
      'checkinCall.error.audio_unavailable'
    );
  const localizedAudioKey = language + ':' + key;
  const hash = createHash('sha256')
    .update(language + '\n' + voice + '\n' + phrase)
    .digest('hex');
  const stored = await pool.query(
    'SELECT audio_data, mime_type FROM checkin_call_audio WHERE audio_key = $1 AND text_hash = $2',
    [localizedAudioKey, hash]
  );
  if (stored.rows.length) return stored.rows[0];
  if (!process.env.VIENEU_API_KEY) {
    throw audioError('VieNeu is not configured', 503, 'checkinCall.error.audio_unavailable');
  }
  const response = await fetch('https://api.vieneu.io/api/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + process.env.VIENEU_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      input: phrase,
      voice,
      response_format: 'mp3',
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw audioError('VieNeu failed', 503, 'checkinCall.error.audio_unavailable');
  const data = Buffer.from(await response.arrayBuffer());
  if (!data.length || data.length > 2_000_000) {
    throw audioError('Invalid VieNeu audio', 503, 'checkinCall.error.audio_unavailable');
  }
  const saved = await pool.query(
    'INSERT INTO checkin_call_audio (audio_key, text_hash, audio_data) VALUES ($1,$2,$3) ON CONFLICT (audio_key) DO UPDATE SET text_hash = EXCLUDED.text_hash, audio_data = EXCLUDED.audio_data, created_at = now() RETURNING audio_data, mime_type',
    [localizedAudioKey, hash, data]
  );
  return saved.rows[0];
}

async function prewarm(pool) {
  if (!process.env.VIENEU_API_KEY) return;
  for (const language of ['vi', 'en']) {
    if (language === 'en' && !process.env.VIENEU_VOICE_EN) continue;
    for (const key of AUDIO_KEYS) {
      try {
        await getAudio(pool, key, language);
      } catch (error) {
        console.error('[checkin-call] audio prewarm failed', language, key, error.message);
      }
    }
  }
}

module.exports = { AUDIO_KEYS, PHRASES, getAudio, normalizeLanguage, prewarm };
