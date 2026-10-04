'use strict';

const earlySignalService = require('./early-signal.service');

function evaluate(pool, requesterUserId, body, lang) {
  const userId = Number(body?.user_id || requesterUserId);
  return earlySignalService.evaluate(pool, userId, {
    requestedBy: requesterUserId,
    triggerType: 'manual',
    lang,
  });
}

function latest(pool, requesterUserId, query, lang) {
  const userId = Number(query.user_id || requesterUserId);
  return earlySignalService.latest(pool, userId, requesterUserId, lang);
}

function familyLatest(pool, requesterUserId, lang) {
  return earlySignalService.familyLatest(pool, requesterUserId, lang);
}

module.exports = { evaluate, latest, familyLatest };
