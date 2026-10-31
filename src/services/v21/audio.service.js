'use strict';
const c = require('./common'),
  p = require('./medication.policy');
const { withPublicAiTemplate } = require('../ai/ai-consent.service');
const cache = require('../checkin-call/conclusion-audio.service');
const PHRASES = {
  prompt: {
    vi: 'Đến giờ uống thuốc rồi ạ. Bác bấm một nếu đã uống, hai nếu bỏ qua cữ này, ba nếu hết thuốc.',
    en: 'It is time for your medication. Press one if taken, two to skip this dose, or three if you have run out.',
  },
  taken: {
    vi: 'Asinu đã ghi nhận bác xác nhận uống cữ thuốc này ạ.',
    en: 'Asinu has recorded your confirmation for this dose.',
  },
  skipped: {
    vi: 'Asinu đã ghi nhận bác bỏ qua cữ thuốc này ạ.',
    en: 'Asinu has recorded that you skipped this dose.',
  },
  out: {
    vi: 'Asinu đã ghi nhận bác báo hết thuốc ạ.',
    en: 'Asinu has recorded that you have run out of medication.',
  },
  checkin: {
    vi: 'Hôm nay bác thấy trong người thế nào? Bấm một nếu khỏe, hai nếu hơi mệt, ba nếu không khỏe.',
    en: 'How are you feeling today? Press one if well, two if a little tired, or three if unwell.',
  },
  consent: {
    vi: 'Người thân vừa cài lịch nhắc thuốc cho bác. Bác bấm một để đồng ý, hai nếu không muốn nhận.',
    en: 'Your family has set up medication reminders for you. Press one to accept or two to decline.',
  },
};
function phrase(phase, lang = 'vi') {
  if (!PHRASES[phase]) throw c.error('MED_AUDIO_PHASE_INVALID');
  return PHRASES[phase][String(lang).toLowerCase().startsWith('en') ? 'en' : 'vi'];
}
async function getAudio(db, user, id, phase, lang = 'vi', consent = false) {
  c.uuid.parse(id);
  await c.assertFeature(db, user, 'medication');
  const row = consent
    ? (
        await db.query('SELECT id FROM med_schedules WHERE id=$1 AND patient_user_id=$2', [
          id,
          user,
        ])
      ).rows[0]
    : (
        await db.query('SELECT id FROM med_dose_events WHERE id=$1 AND patient_user_id=$2', [
          id,
          user,
        ])
      ).rows[0];
  if (!row) throw c.error('MED_DOSE_NOT_FOUND', 404);
  const text = phrase(phase, lang);
  // Only these fixed, nonpersonal sentences enter public-template context.
  // No names, schedule, photo, free text, or medication details go to TTS.
  const language = String(lang).toLowerCase().startsWith('en') ? 'en' : 'vi';
  try {
    return await withPublicAiTemplate(() => cache.getConclusionAudio(user, text, language));
  } catch (error) {
    const fs = require('node:fs/promises'),
      path = require('node:path');
    try {
      return {
        mime_type: 'audio/wav',
        audio_data: await fs.readFile(
          path.join(__dirname, '../../../assets/medication-audio', language + '-' + phase + '.wav')
        ),
      };
    } catch {
      throw error;
    }
  }
}
module.exports = { PHRASES, phrase, getAudio };
