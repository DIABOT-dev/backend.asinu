'use strict';

const spokenKeys = ['Một', 'Hai', 'Ba', 'Bốn', 'Năm', 'Sáu'];

function spokenQuestion(question, introduction) {
  return [
    introduction,
    question.text,
    ...question.options.map((o) => `${spokenKeys[o.key - 1]}: ${o.label.replace(/[.!?]+$/u, '')}.`),
  ]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

// One script for cached TTS and the app fallback. Keep the question and its
// choices in one utterance, with a greeting only on the first question.
function questionSpeech(content, questionId) {
  const index = content.questions.findIndex((q) => q.id === questionId);
  if (index < 0) return null;
  const question = content.questions[index];
  const introduction = index === 0 ? content.greeting : question.fixed ? 'Cuối cùng,' : '';
  return spokenQuestion(question, introduction);
}

module.exports = { questionSpeech, spokenQuestion };
