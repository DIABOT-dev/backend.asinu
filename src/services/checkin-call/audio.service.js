const { createHash } = require('crypto');
const { t } = require('../../i18n');

const MAX_DYNAMIC_TEXT_LENGTH = 1600;

const AUDIO_KEYS = Object.freeze([
  'user_prompt',
  'triage_prompt',
  'triage_location_prompt',
  'triage_symptom_prompt',
  'triage_intensity_prompt',
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

function synthesisTimeoutMs() {
  const configured = Number(process.env.VIENEU_TIMEOUT_MS || 20000);
  return Number.isFinite(configured) ? Math.max(1000, Math.min(configured, 60000)) : 20000;
}

function voiceForLanguage(language) {
  return language === 'en'
    ? process.env.VIENEU_VOICE_EN
    : process.env.VIENEU_VOICE || 'Ngọc Lan';
}

// Opaque public revision: never include API keys or user data in this hash.
// The optional revision also lets operators invalidate changed provider voices
// that keep the same name, without rebuilding the mobile app.
function audioVersion(requestedLanguage = 'vi', selectedVoice) {
  const language = normalizeLanguage(requestedLanguage);
  const voice = selectedVoice ?? voiceForLanguage(language) ?? '';
  return createHash('sha256')
    .update(JSON.stringify({
      schema: 'checkin-call-audio-v2',
      provider: 'vieneu',
      format: 'mp3',
      language,
      voice,
      revision: process.env.CHECKIN_CALL_AUDIO_REVISION || '1',
      phrases: AUDIO_KEYS.map((key) => PHRASES[key][language]),
    }))
    .digest('hex');
}

async function requestSpeech(phrase, voice, version) {
  if (!process.env.VIENEU_API_KEY) {
    throw audioError('VieNeu is not configured', 503, 'checkinCall.error.audio_unavailable');
  }
  let response;
  try {
    response = await fetch('https://api.vieneu.io/api/v1/audio/speech', {
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
      signal: AbortSignal.timeout(synthesisTimeoutMs()),
    });
  } catch (error) {
    throw audioError(
      error?.name === 'TimeoutError' || error?.name === 'AbortError'
        ? 'VieNeu timed out'
        : 'VieNeu unavailable',
      503,
      'checkinCall.error.audio_unavailable'
    );
  }
  if (!response.ok) throw audioError('VieNeu failed', 503, 'checkinCall.error.audio_unavailable');
  const data = Buffer.from(await response.arrayBuffer());
  if (!data.length || data.length > 2_000_000) {
    throw audioError('Invalid VieNeu audio', 503, 'checkinCall.error.audio_unavailable');
  }
  const responseMimeType = response.headers?.get?.('content-type');
  return {
    audio_data: data,
    mime_type: responseMimeType?.startsWith('audio/') ? responseMimeType : 'audio/mpeg',
    audio_version: version,
  };
}

async function synthesizeText(input, requestedLanguage = 'vi') {
  const language = normalizeLanguage(requestedLanguage);
  const phrase = typeof input === 'string' ? input.replace(/\s+/g, ' ').trim() : '';
  if (!phrase) throw audioError('Conclusion text is required', 400, 'checkinCall.error.conclusion_required');
  if (phrase.length > MAX_DYNAMIC_TEXT_LENGTH) {
    throw audioError('Conclusion text is too long', 400, 'checkinCall.error.conclusion_too_long');
  }
  const voice = voiceForLanguage(language);
  if (!voice) {
    throw audioError(
      'TTS voice is not configured for this language',
      503,
      'checkinCall.error.audio_unavailable'
    );
  }
  return requestSpeech(phrase, voice, audioVersion(language, voice));
}

async function getAudio(pool, key, requestedLanguage = 'vi') {
  const language = normalizeLanguage(requestedLanguage);
  const phrase = PHRASES[key]?.[language];
  if (!phrase) throw audioError('Unknown audio key', 404, 'checkinCall.error.unknown_audio');
  const voice = voiceForLanguage(language);
  // Do not synthesize English with a Vietnamese-only voice. The app will use
  // its en-US system voice until an English-capable backend voice is configured.
  if (!voice)
    throw audioError(
      'English TTS voice is not configured',
      503,
      'checkinCall.error.audio_unavailable'
    );
  const localizedAudioKey = language + ':' + key;
  const version = audioVersion(language, voice);
  const hash = createHash('sha256')
    .update(version + '\n' + phrase)
    .digest('hex');
  const stored = await pool.query(
    'SELECT audio_data, mime_type FROM checkin_call_audio WHERE audio_key = $1 AND text_hash = $2',
    [localizedAudioKey, hash]
  );
  if (stored.rows.length) return { ...stored.rows[0], audio_version: version };
  const generated = await requestSpeech(phrase, voice, version);
  const saved = await pool.query(
    'INSERT INTO checkin_call_audio (audio_key, text_hash, mime_type, audio_data) VALUES ($1,$2,$3,$4) ON CONFLICT (audio_key) DO UPDATE SET text_hash = EXCLUDED.text_hash, mime_type = EXCLUDED.mime_type, audio_data = EXCLUDED.audio_data, created_at = now() RETURNING audio_data, mime_type',
    [localizedAudioKey, hash, generated.mime_type, generated.audio_data]
  );
  return { ...saved.rows[0], audio_version: version };
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

module.exports = {
  AUDIO_KEYS,
  MAX_DYNAMIC_TEXT_LENGTH,
  PHRASES,
  audioVersion,
  getAudio,
  normalizeLanguage,
  prewarm,
  synthesizeText,
  synthesisTimeoutMs,
};
