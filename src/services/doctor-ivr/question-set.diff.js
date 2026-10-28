'use strict';
function questionSetChanges(before, after) {
  const changes = [];
  for (const field of ['title', 'greeting', 'closing', 'est_duration_s'])
    if (JSON.stringify(before?.[field]) !== JSON.stringify(after[field]))
      changes.push({ field, before: before?.[field] ?? null, after: after[field] });
  const previous = new Map((before?.questions || []).map((q) => [q.id, q]));
  const next = new Map(after.questions.map((q) => [q.id, q]));
  for (const id of new Set([...previous.keys(), ...next.keys()]))
    if (JSON.stringify(previous.get(id)) !== JSON.stringify(next.get(id)))
      changes.push({
        question_id: id,
        before: previous.get(id) ?? null,
        after: next.get(id) ?? null,
      });
  const order = after.questions.map((q) => q.id),
    oldOrder = (before?.questions || []).map((q) => q.id);
  if (JSON.stringify(oldOrder) !== JSON.stringify(order))
    changes.push({ field: 'question_order', before: oldOrder, after: order });
  return changes;
}
module.exports = { questionSetChanges };
