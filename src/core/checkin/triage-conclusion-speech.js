'use strict';

function plainSpeech(value) {
  return String(value || '')
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

// Speech follows the same content/order as the visible result. Provider-sized
// requests are handled by the audio service, never by dropping medical text.
function conclusionSpeech(result) {
  const body =
    result.conclusionFormat === 'narrative'
      ? [result.narrative]
      : [
          result.personalMessage,
          result.explanation,
          ...(result.todo || []),
          ...(result.seeDoctorWhen || []),
        ];
  const parts = body.map(plainSpeech).filter(Boolean);
  for (const value of [result.disclaimer, result.closeMessage, result.aiNotice]) {
    const text = plainSpeech(value);
    if (text && !parts.some((part) => part === text || part.endsWith(' ' + text))) parts.push(text);
  }
  return parts.join(' ');
}

module.exports = { plainSpeech, conclusionSpeech };
