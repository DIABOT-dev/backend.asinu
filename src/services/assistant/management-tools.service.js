'use strict';
const { createHash } = require('node:crypto');
const c = require('../v21/common');
const med = require('../v21/medication.service');
const purposes = require('../v21/medication-purpose.service');
const drafts = require('../v21/medication-drafts.service');
const data = require('./domain-tools.read');
const { planDefinition } = require('../payment/subscription-catalog');
const tools = new Set(['medication.drafts', 'medication.draft_resume', 'medication.draft_delete',
  'medication.purposes', 'medication.purpose', 'subscription.members', 'subscription.member_add', 'subscription.member_remove']);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const conflict = () => c.error('APP_ASSISTANT_TOOL_CONFLICT', 409);
const tagLabels = {
  fever_reduction: ['Hạ sốt', 'Fever relief'], pain_relief: ['Giảm đau', 'Pain relief'], blood_pressure: ['Huyết áp', 'Blood pressure'],
  diabetes: ['Đường huyết', 'Blood sugar'], lipids: ['Mỡ máu', 'Blood lipids'], antibiotic: ['Kháng sinh', 'Antibiotic'],
  allergy: ['Dị ứng', 'Allergy'], cough: ['Ho', 'Cough'], stomach: ['Dạ dày', 'Stomach'],
};
const labels = (codes, en) => codes.map(code => tagLabels[code]?.[Number(en)]).filter(Boolean).join(', ') || (en ? 'None' : 'Không có');
const draftName = (row, en) => row.snapshot.items.map(item => item.display_name.trim()).filter(Boolean).join(', ') || (en ? 'Untitled draft' : 'Bản nháp chưa đặt tên');
async function medicationItem(db, owner, id) {
  await c.patientAccess(db, owner, owner, { selfOnly: true });
  await c.assertFeature(db, owner, 'medication'); med.requireEncryption();
  return (await db.query('SELECT * FROM med_items WHERE patient_user_id=$1 AND active' + (id ? ' AND id=$2 FOR UPDATE' : ' ORDER BY created_at,id'), id ? [owner, id] : [owner])).rows;
}
async function household(db, owner, lock = false) {
  const h = (await db.query('SELECT * FROM subscription_households WHERE owner_user_id=$1' + (lock ? ' FOR UPDATE' : ''), [owner])).rows[0];
  if (!h) return null;
  // Capacity counts every occupied seat, even if a deleted account is hidden
  // from name display. Otherwise the legacy add flow could replace the owner.
  const members = (await db.query(`SELECT m.user_id,m.added_at,CASE WHEN u.deleted_at IS NULL THEN COALESCE(u.full_name,u.display_name) END name
    FROM subscription_household_members m LEFT JOIN users u ON u.id=m.user_id
    WHERE m.household_id=$1 AND m.status='active' ORDER BY m.user_id`, [h.id])).rows;
  return { ...h, members };
}
const activePlan = h => h && planDefinition(h.plan_code).code !== 'free' && ['active', 'grace_period'].includes(h.status) && new Date(h.current_period_end) > new Date();
const householdVersion = h => digest([h.id, h.plan_code, h.status, h.current_period_end, h.members.map(row => [row.user_id, row.added_at])]);
const itemVersion = row => digest([row.id, row.display_name, row.kind, row.tags_json]);
async function prepare(db, owner, tool, args, lang = 'vi', { signal } = {}) {
  signal?.throwIfAborted();
  const en = lang === 'en', q = (vi, english) => ({ clarify: en ? english : vi });
  if (tool.startsWith('medication.draft')) {
    // Normal draft reads can recover old scans by writing a draft. Chat previews
    // deliberately use the read-only variant, including when the list is empty.
    const { drafts: rows } = await drafts.read(db, owner, owner, { recoverLegacy: false });
    if (tool === 'medication.drafts') return { answer: rows.length ? rows.map((row, i) => `${i + 1}. ${draftName(row, en)} · ${en ? 'Step' : 'Bước'} ${row.snapshot.step}/4`).join('\n')
      : en ? 'You have no unfinished medication drafts.' : 'Bạn chưa có bản nháp lịch thuốc nào.' };
    const row = args.target ? data.choose(rows, args.target, row => draftName(row, en)) : rows.length === 1 ? rows[0] : null;
    if (!row) return q(rows.length ? `Bạn muốn chọn bản nháp nào: ${rows.map((row, i) => `${i + 1}. ${draftName(row, en)}`).join('; ')}?` : 'Bạn chưa có bản nháp lịch thuốc nào.',
      rows.length ? `Which draft: ${rows.map((row, i) => `${i + 1}. ${draftName(row, en)}`).join('; ')}?` : 'You have no unfinished medication drafts.');
    if (tool === 'medication.draft_resume') return { screen: { screen: 'medication_draft', params: { id: row.id } } };
    return { payload: { id: row.id, revision: row.revision }, label: `${en ? 'Delete medication draft' : 'Xoá bản nháp lịch thuốc'}\n${draftName(row, en)}` };
  }
  if (tool === 'medication.purpose' || tool === 'medication.purposes') {
    const rows = await medicationItem(db, owner);
    const row = data.choose(rows, args.target, row => med.reveal(owner, 'med_items.display_name', row.display_name));
    if (!row) return q('Bạn cho mình tên thuốc cần chọn nhé. Nếu có nhiều thuốc cùng tên, hãy cho biết vị trí trong danh sách.', 'Please specify the medicine name or its position in the list.');
    const item = med.publicItem(row), current = item.purpose_tags?.codes || [];
    if (item.kind !== 'MEDICINE') return { answer: en ? 'Supplement reminders do not use medicine-purpose tags.' : 'Lịch nhắc thực phẩm bổ sung không dùng tag công dụng dành cho thuốc.' };
    const lookup = tool === 'medication.purposes' || ['add', 'set'].includes(args.mode) && args.tags.some(code => !current.includes(code))
      ? await purposes.lookup(db, owner, owner, { name: item.display_name, kind: 'MEDICINE' }, { signal }) : null;
    signal?.throwIfAborted();
    if (tool === 'medication.purposes') return { answer: `${item.display_name}\n${en ? 'Selected' : 'Đang chọn'}: ${labels(current, en)}\n${en ? 'Verified available tags' : 'Tag tra cứu được'}: ${labels(lookup?.tags || [], en)}` };
    const next = args.mode === 'clear' ? [] : args.mode === 'remove' ? current.filter(code => !args.tags.includes(code))
      : args.mode === 'add' ? [...new Set([...current, ...args.tags])] : args.tags;
    if (digest(next.slice().sort()) === digest(current.slice().sort())) return { answer: en ? 'Those purpose tags are already set.' : 'Các tag công dụng hiện tại đã đúng với yêu cầu rồi nhé.' };
    const allowed = new Set([...current, ...(lookup?.status === 'matched' ? lookup.tags : [])]);
    if (next.some(code => !allowed.has(code))) return q('Nguồn tra cứu chưa xác nhận công dụng này cho thuốc đã chọn. Mình chưa gắn tag nhé.', 'The manufacturer has not verified that purpose for the selected medicine. No tag has been added.');
    // Any newly added tag needs a complete, valid manufacturer capability.
    const adding = next.some(code => !current.includes(code));
    const confirmation = adding ? purposes.confirmationSchema.parse({ token: lookup.token, codes: next }) : null;
    if (confirmation) purposes.confirmedTags(owner, owner, { display_name: item.display_name, kind: 'MEDICINE', tag_confirmation: confirmation });
    return { payload: { id: item.id, before: itemVersion(row), codes: next, confirmation },
      label: `${en ? 'Change purpose tags' : 'Đổi tag công dụng'} · ${item.display_name}\n${labels(current, en)} → ${labels(next, en)}` };
  }
  const h = await household(db, owner);
  if (tool === 'subscription.members' && h && h.plan_code !== 'free' && !activePlan(h))
    return { answer: en ? 'Your paid care plan is not currently active. Check Care plans for its current status.' : 'Gói An Tâm của bạn hiện không còn hiệu lực. Bạn xem lại trạng thái tại Gói chăm sóc nhé.' };
  if (tool === 'subscription.members') return { answer: h ? `${en ? 'Protected members' : 'Thành viên gói chăm sóc'}: ${h.members.length}/${activePlan(h) ? planDefinition(h.plan_code).protectedMemberLimit : 1}\n${h.members.map((row, i) => `${i + 1}. ${row.name || (en ? 'Member' : 'Thành viên')}${Number(row.user_id) === Number(owner) ? en ? ' (you)' : ' (bạn)' : ''}`).join('\n')}`
    : en ? 'You do not own a care plan with protected members.' : 'Bạn chưa có gói chăm sóc do mình làm chủ để quản lý thành viên.' };
  if (!activePlan(h)) return q('Bạn cần là chủ gói An Tâm đang còn hạn để quản lý thành viên gói.', 'You must own an active An Tam care plan to manage its members.');
  const adding = tool === 'subscription.member_add';
  const candidates = adding ? (await db.query(`SELECT u.id user_id,COALESCE(u.full_name,u.display_name) name FROM users u
    WHERE u.deleted_at IS NULL AND u.id<>$1 AND EXISTS(SELECT 1 FROM user_connections c WHERE c.status='accepted'
      AND ((c.requester_id=$1 AND c.addressee_id=u.id) OR (c.addressee_id=$1 AND c.requester_id=u.id))) ORDER BY u.id`, [owner])).rows : h.members;
  const member = data.choose(candidates, args.target, row => row.name || '');
  if (!member) return q('Bạn muốn chọn người nào trong danh sách người thân? Hãy cho mình tên đầy đủ để tránh chọn nhầm nhé.', 'Please give the full name of the connected relative or protected member.');
  if (Number(member.user_id) === Number(owner)) return q('Thao tác này dùng để gỡ người thân khỏi gói chăm sóc. Bạn vẫn là chủ gói nhé.', 'This action removes a relative from the care plan. You remain its owner.');
  if (adding && h.members.some(row => Number(row.user_id) === Number(member.user_id))) return { answer: en ? 'This person is already protected by your plan.' : 'Người thân này đã có trong gói chăm sóc của bạn rồi.' };
  if (adding && h.members.length >= planDefinition(h.plan_code).protectedMemberLimit)
    return q('Gói đã đủ số người được bảo vệ. Bạn chọn gỡ một thành viên trước nhé; mình không tự thay suất của bạn.', 'Your plan is full. Please choose a member to remove first; your own place will not be replaced automatically.');
  return { payload: { householdId: h.id, memberId: Number(member.user_id), before: householdVersion(h) },
    label: `${adding ? en ? 'Add protected member' : 'Thêm thành viên vào gói' : en ? 'Remove protected member' : 'Gỡ thành viên khỏi gói'}\n${member.name}` };
}

async function execute(pool, owner, plan, token, lang = 'vi') {
  const { tool, payload: p } = plan;
  const result = await c.transaction(pool, async db => {
    if (tool.startsWith('subscription.')) await require('../payment/iap-revocation.service').lockPurchaseOwner(db, owner);
    await c.lockPatient(db, owner);
    await db.query('SELECT user_id FROM user_ai_consents WHERE user_id=$1 FOR SHARE', [owner]);
    if (!(await require('../ai/ai-consent.service').hasAiConsent(db, owner))) throw c.error('AI_CONSENT_REQUIRED', 403);
    const fingerprint = digest(token);
    const receipt = (await db.query('SELECT fingerprint FROM assistant_action_receipts WHERE owner_id=$1 AND request_id=$2', [owner, plan.jti])).rows[0];
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) throw conflict();
      return { status: 'applied', replay: true };
    }
    if (tool === 'medication.draft_delete') await drafts.remove(db, owner, owner, p.id, p.revision);
    else if (tool === 'medication.purpose') {
      const row = (await medicationItem(db, owner, p.id))[0];
      if (!row || itemVersion(row) !== p.before) throw conflict();
      const item = med.publicItem(row);
      let tags = null;
      if (p.codes.length) {
        if (p.confirmation) tags = purposes.confirmedTags(owner, owner, { display_name: item.display_name, kind: item.kind, tag_confirmation: p.confirmation });
        else {
          if (!p.codes.every(code => item.purpose_tags?.codes.includes(code))) throw conflict();
          tags = { ...item.purpose_tags, codes: p.codes, confirmedBy: Number(owner), confirmedAt: new Date().toISOString() };
        }
      }
      await db.query('UPDATE med_items SET tags_json=$3 WHERE patient_user_id=$1 AND id=$2', [owner, p.id, tags ? med.protect(owner, 'med_items.tags_json', JSON.stringify(tags)) : null]);
    } else {
      const h = await household(db, owner, true);
      if (!activePlan(h) || String(h.id) !== String(p.householdId) || householdVersion(h) !== p.before || p.memberId === Number(owner)) throw conflict();
      if (tool === 'subscription.member_add' && h.members.length >= planDefinition(h.plan_code).protectedMemberLimit) throw conflict();
      const service = require('../payment/household.service');
      if (tool === 'subscription.member_add') await service.addProtectedMember(db, owner, p.memberId, lang);
      else if (tool === 'subscription.member_remove') await service.removeProtectedMember(db, owner, p.memberId, lang);
      else throw conflict();
    }
    await db.query('INSERT INTO assistant_action_receipts(owner_id,request_id,fingerprint) VALUES($1,$2,$3)', [owner, plan.jti, fingerprint]);
    return { status: 'applied' };
  });
  // A nested service may invalidate before the outer commit; repeat afterwards
  // so concurrent reads cannot retain a snapshot from before confirmation.
  if (tool.startsWith('subscription.')) await Promise.all([owner, p.memberId].map(id => require('../payment/entitlement.service').invalidateEntitlement(id)));
  return result;
}
module.exports = { handles: tool => tools.has(tool), prepare, execute, household, labels };
