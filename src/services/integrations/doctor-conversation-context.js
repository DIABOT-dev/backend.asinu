'use strict';

// Scheduling/SLA messages are shown in the chat but are not clinical answers
// from a specialist. Keep speaker identity intact before planning the next turn.
const clinicalConversation = (context = {}) =>
  (context.conversation || []).filter(
    (turn) =>
      ['patient', 'doctor'].includes(turn.role) &&
      turn.sender_ref !== 'doctor-sla-worker' &&
      !turn.is_deleted &&
      typeof turn.message === 'string' &&
      turn.message.trim()
  );

module.exports = { clinicalConversation };
