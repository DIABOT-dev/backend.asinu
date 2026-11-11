'use strict';

const VI_SPEECH_REVISION = 'vi-ai-expanded-v1';

// Spoken wording only. Do not change display copy, the Vietnamese pronoun
// "ai", names such as Mai, or abbreviations containing AI as a substring.
function normalizeCheckinSpeech(input, language = 'vi') {
  if (typeof input !== 'string') return '';
  if (String(language).toLowerCase().startsWith('en')) return input;
  return input.replace(/(^|[^\p{L}\p{N}_])AI(?=$|[^\p{L}\p{N}_])/gu, '$1trí tuệ nhân tạo');
}

module.exports = { VI_SPEECH_REVISION, normalizeCheckinSpeech };
