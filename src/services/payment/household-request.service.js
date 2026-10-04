'use strict';

const householdService = require('./household.service');

function listMembers(pool, ownerUserId, lang) {
  return householdService.listProtectedMembers(pool, ownerUserId, lang);
}

function addMember(pool, ownerUserId, body, lang) {
  return householdService.addProtectedMember(pool, ownerUserId, Number(body?.user_id), lang);
}

function removeMember(pool, ownerUserId, params, lang) {
  return householdService.removeProtectedMember(pool, ownerUserId, Number(params.userId), lang);
}

module.exports = { listMembers, addMember, removeMember };
