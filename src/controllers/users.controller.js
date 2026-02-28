/**
 * User Search Controller
 * For searching users in the system (for care circle invitations, etc.)
 */

const { t, getLang } = require('../i18n');
const usersService = require('../services/users.service');

async function searchUsers(pool, req, res) {
  const query = String(req.query.q || '').trim();
  
  if (!query || query.length < 2) {
    return res.status(400).json({ ok: false, error: t('error.query_too_short', getLang(req)) });
  }

  const result = await usersService.searchUsers(pool, req.user.id, query);

  if (!result.ok) {
    return res.status(500).json(result);
  }

  return res.status(200).json(result);
}

async function getAllUsers(pool, req, res) {
  const result = await usersService.getAllUsers(pool, req.user.id, 100);

  if (!result.ok) {
    return res.status(500).json(result);
  }

  return res.status(200).json(result);
}

module.exports = {
  searchUsers,
  getAllUsers
};
