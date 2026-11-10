'use strict';

const {
  requiredMeasurementTypes,
  normalizeConditionalWarnings,
} = require('./triage-conclusion-contract');
const { plain, containsVisit, visitFault } = require('./triage-conclusion-guards');
const segmenter = new Intl.Segmenter('vi', { granularity: 'sentence' });
const CONCLUSION_PROMPT_VERSION = 'v3';
const CONCLUSION_RENDER_VERSION = 2;

function requiredActions(facts, lang) {
  const en = lang === 'en';
  const result = [
    en
      ? 'Record 2 details: when the discomfort starts and when it changes.'
      : 'Ghi 2 mốc giờ: lúc khó chịu xuất hiện và lúc thay đổi.',
  ];
  const metrics = requiredMeasurementTypes(facts).map((type) =>
    en
      ? type === 'huyet_ap'
        ? 'blood pressure'
        : 'blood glucose'
      : type === 'huyet_ap'
        ? 'huyết áp'
        : 'đường huyết'
  );
  if (metrics.length)
    result.push(
      en
        ? `Measure your ${metrics.join(' and ')} again and note the time.`
        : `Đo lại ${metrics.join(' và ')} và ghi giờ đo.`
    );
  return result;
}

function requiredVisit(facts, lang) {
  if (lang === 'en')
    return `Please arrange an assessment ${facts.care_level === 'kham_trong_ngay' ? 'today' : 'over the next few days'}.`;
  const title = facts.xung_ho.goi.charAt(0).toUpperCase() + facts.xung_ho.goi.slice(1);
  return `${title} nên đi khám ${facts.care_level === 'kham_trong_ngay' ? 'hôm nay' : 'trong vài ngày tới'}.`;
}

/** Repair presentation with server-owned instructions, keeping every AI statement
 * for the safety checks that follow. Never change clinical values or urgency. */
function normalizeConclusionCandidate(input, facts, lang = 'vi') {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return { candidate: input, repairs: [] };
  const candidate = { ...input };
  const repairs = [];
  const validList = (value) =>
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === 'string' && item.trim());
  for (const key of ['nen_lam', 'di_kham_khi']) {
    if (validList(candidate[key]))
      candidate[key] = [...new Set(candidate[key].map((item) => item.trim()))];
  }
  if (validList(candidate.nen_lam)) {
    for (const action of requiredActions(facts, lang)) {
      const actionPlain = plain(action);
      const equivalent = candidate.nen_lam.some(
        (item) =>
          plain(item) === actionPlain ||
          (/^(?:ghi 2 moc gio|record 2 details)/.test(actionPlain) &&
            /(?:ghi (?:lai )?(?:2|hai) moc gio:? luc kho chiu xuat hien va luc thay doi|record 2 details: when (?:the )?discomfort starts and when it changes)/.test(
              plain(item)
            )) ||
          (/^(?:do lai|measure your)/.test(actionPlain) &&
            /^(?:do lai|measure your)/.test(plain(item)) &&
            requiredMeasurementTypes(facts).every((type) =>
              (type === 'huyet_ap' ? /huyet ap|blood pressure/ : /duong huyet|blood glucose/).test(
                plain(item)
              )
            ) &&
            /gio do|time/.test(plain(item)))
      );
      if (!equivalent) {
        candidate.nen_lam.push(action);
        repairs.push({ block: 'nen_lam', reason: 'required_action_added' });
      }
    }
  }
  if (validList(candidate.di_kham_khi)) {
    // Move complete referral sentences into the warning block, instead of
    // throwing away the surrounding useful explanation. Safety scans see both.
    for (const key of ['loi_nhan', 'lien_quan']) {
      if (typeof candidate[key] !== 'string') continue;
      const parts = [...segmenter.segment(candidate[key])]
        .map(({ segment }) => segment.trim())
        .filter(Boolean);
      const moved = parts.filter(containsVisit);
      if (moved.length) {
        candidate[key] = parts.filter((part) => !containsVisit(part)).join(' ');
        candidate.di_kham_khi.push(...moved);
        repairs.push({ block: key, reason: 'referral_moved_to_warnings' });
      }
    }
    candidate.di_kham_khi = normalizeConditionalWarnings([...new Set(candidate.di_kham_khi)], lang);
    const fault = visitFault(candidate.di_kham_khi, facts.care_level);
    const hasTimedReferral = candidate.di_kham_khi.some(
      (item) =>
        containsVisit(item) &&
        !/\b(?:neu|khi|if|when|trong truong hop)\b/.test(plain(item)) &&
        (facts.care_level === 'kham_trong_ngay'
          ? /hom nay|trong ngay|today/.test(plain(item))
          : /vai ngay|tuan nay|sap toi|few days|this week|soon/.test(plain(item)))
    );
    if (
      facts.care_level !== 'tu_theo_doi' &&
      (fault === 'required_referral_missing' || (!fault && !hasTimedReferral))
    ) {
      candidate.di_kham_khi.unshift(requiredVisit(facts, lang));
      repairs.push({ block: 'di_kham_khi', reason: 'required_referral_added' });
    }
  }
  return { candidate, repairs };
}

module.exports = {
  normalizeConclusionCandidate,
  requiredActions,
  requiredVisit,
  CONCLUSION_PROMPT_VERSION,
  CONCLUSION_RENDER_VERSION,
};
