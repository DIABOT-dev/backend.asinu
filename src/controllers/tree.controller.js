/**
 * Tree Controller
 * Handles tree (health score) summary and history
 */

const treeService = require('../services/tree.service');

async function getTreeSummary(pool, req, res) {
  if (!req.user?.id) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const result = await treeService.getTreeSummary(pool, req.user.id);

  if (!result.ok) {
    return res.status(500).json(result);
  }

  return res.status(200).json(result);
}

async function getTreeHistory(pool, req, res) {
  if (!req.user?.id) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const result = await treeService.getTreeHistory(pool, req.user.id);

  if (!result.ok) {
    return res.status(500).json(result);
  }

  return res.status(200).json(result.history);
}

module.exports = {
  getTreeSummary,
  getTreeHistory
};
