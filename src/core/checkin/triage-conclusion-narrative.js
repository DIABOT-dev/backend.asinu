'use strict';

const { callTextAi } = require('../../services/ai/ai.service');
const logger = require('../../lib/logger');
const {
  buildConclusionFacts,
  validateBlock,
  fallbackBlocks,
  composeConclusion,
} = require('./triage-conclusion');
const { buildNarrativeSystem, buildNarrativePrompt } = require('./triage-conclusion-prompt');
const {
  normalizeMeasurementSentences,
  conclusionLanguageFault,
  requiredMeasurementTypes,
} = require('./triage-conclusion-contract');
const { requiredVisit, requiredActions } = require('./triage-conclusion-normalize');
const { containsVisit, visitFault, plain } = require('./triage-conclusion-guards');
const sentenceSegmenter = new Intl.Segmenter('vi', { granularity: 'sentence' });
const measurementFaults = new Set([
  'measurement_time_not_exact',
  'ungrounded_measurement',
  'measurement_type_mismatch',
  'measurement_unit_missing',
  'ambiguous_measurement_reference',
  'unverified_vital_interpretation',
]);
function currentReading(facts, type) {
  return facts.chi_so_24h
    .filter((r) => r.loai === type)
    .sort((a, b) => new Date(b.measured_at) - new Date(a.measured_at))[0];
}
function readingSentence(record, lang) {
  return lang === 'en'
    ? `Your ${record.loai === 'huyet_ap' ? 'blood pressure' : 'blood glucose'} was ${record.gia_tri} ${record.don_vi} at ${record.luc}.`
    : `${record.loai === 'huyet_ap' ? 'Huyết áp' : 'Đường huyết'} ghi lúc ${record.luc}: ${record.gia_tri} ${record.don_vi}.`;
}

function unsupportedInterpretation(sentence) {
  const text = plain(sentence);
  if (
    /chua (?:the |du )?(?:biet|noi|ket luan|khang dinh)|khong (?:co nghia|the ket luan)|cannot (?:say|conclude)|does not (?:mean|establish)/.test(
      text
    )
  )
    return null;
  if (
    /(?:benh nen|tieu duong|huyet ap|tim mach|conditions?).{0,80}(?:kiem soat.{0,18}tot|well.controlled)/.test(
      text
    )
  )
    return 'unverified_condition_control';
  if (
    /(?:huyet ap|duong huyet|chi so|muc.{0,18}nay|these readings|this (?:level|reading)).{0,70}(?:dang|van|la |o muc|nam trong|is |are ).{0,35}(?:on dinh|binh thuong|kha tot|gioi han tot|stable|normal|good)/.test(
      text
    )
  )
    return 'unverified_vital_interpretation';
  return null;
}

function plainNarrative(raw) {
  return String(raw || '')
    .normalize('NFC')
    .replace(/^```(?:\w+)?\s*\n?/u, '')
    .replace(/\s*```$/u, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*#{1,6}\s+/gm, '')
    .trim();
}

function adaptSavedConclusion(result) {
  if (
    !result?.isDone ||
    result.isEmergency ||
    result.severity === 'emergency' ||
    result.conclusionFormat === 'narrative'
  )
    return result;
  if (
    !result.personalMessage ||
    !result.explanation ||
    !Array.isArray(result.todo) ||
    !Array.isArray(result.seeDoctorWhen)
  )
    return result;
  return {
    ...result,
    conclusionFormat: 'narrative',
    narrative: [
      result.personalMessage,
      result.explanation,
      result.todo.map((item) => `- ${item}`).join('\n'),
      result.seeDoctorWhen.map((item) => `- ${item}`).join('\n'),
    ]
      .filter(Boolean)
      .join('\n\n'),
  };
}

function sanitizeNarrative(raw, facts) {
  const lines = foldConditionalLists(plainNarrative(raw)).split(/\n/);
  const headingNames = new Set(
    String(raw)
      .split(/\r?\n/)
      .filter((line) => /^\s*#{1,6}\s+/.test(line))
      .map((line) =>
        line
          .replace(/^\s*#{1,6}\s+/, '')
          .replace(/\*\*/g, '')
          .trim()
      )
  );
  const kept = [];
  for (const line of lines) {
    if (!line.trim()) {
      kept.push('');
      continue;
    }
    const bullet = /^\s*(?:[-*•]|\d+[.)])\s+/.test(line);
    const text = line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim();
    const safe = [];
    for (const { segment } of sentenceSegmenter.segment(normalizeMeasurementSentences(text))) {
      const sentence = segment.trim();
      let reason =
        validateBlock('narrative', sentence, facts, { skipCareLevel: true }) ||
        unsupportedInterpretation(sentence) ||
        conclusionLanguageFault(sentence, facts);
      if (
        !reason &&
        facts.chi_tiet_tung_vung?.length &&
        !headingNames.has(text) &&
        (/\?/.test(sentence) ||
          /(?:hãy|có thể|vui lòng).{0,15}cho.{0,12}(?:biết|thêm thông tin)|(?:can|could) you (?:tell|share)/iu.test(
            sentence
          ))
      )
        reason = 'repeated_assessment_question';
      // Keep the patient's actual care level; remove a contradictory direct
      // referral instead of letting the model change the decision.
      if (!reason && containsVisit(sentence)) {
        const careFault = visitFault([sentence], facts.care_level);
        if (careFault && careFault !== 'required_referral_missing') reason = careFault;
      }
      if (!reason && bullet) {
        const actionFault = validateBlock('nen_lam', [sentence, sentence], facts);
        if (
          [
            'nonmedication_actions_only',
            'medication_instruction',
            'unconfirmed_prescription',
          ].includes(actionFault)
        )
          reason = actionFault;
      }
      if (reason) {
        logger.warn('conclusion_rejected', { block: 'narrative', reason, scope: 'sentence' });
        if (measurementFaults.has(reason)) {
          for (const type of ['huyet_ap', 'duong_huyet']) {
            const named =
              type === 'huyet_ap'
                ? /huyết áp|blood pressure|mmHg/iu
                : /đường huyết|blood (?:glucose|sugar)|mg\/dL|mmol\/L/iu;
            const record = named.test(sentence) && currentReading(facts, type);
            if (record) safe.push(readingSentence(record, facts.language));
          }
        }
        continue;
      }
      safe.push(sentence);
    }
    if (safe.length)
      kept.push(`${headingNames.has(text) ? '### ' : bullet ? '- ' : ''}${safe.join(' ')}`);
  }
  return kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function foldConditionalLists(text) {
  const lines = text.split('\n');
  const output = [];
  for (let i = 0; i < lines.length; i++) {
    const lead = lines[i].trim();
    if (/^(?:nếu|khi|if|when)\b/iu.test(lead) && /[:：]$/.test(lead)) {
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      const items = [];
      while (j < lines.length && /^\s*[-*•]\s+/.test(lines[j])) {
        items.push(
          lines[j]
            .replace(/^\s*[-*•]\s+/, '')
            .trim()
            .replace(/[.!]$/, '')
        );
        j++;
      }
      while (j < lines.length && !lines[j].trim()) j++;
      const action = lines[j]?.trim();
      if (
        items.length &&
        action &&
        containsVisit(action) &&
        !/^\s*[-*•]|^(?:nếu|khi|if|when)\b/iu.test(action)
      ) {
        output.push(
          `${lead.slice(0, -1)} ${items.join(', ')}, ${action.charAt(0).toLowerCase() + action.slice(1)}`
        );
        i = j;
        continue;
      }
    }
    output.push(lines[i]);
  }
  return output.join('\n');
}

function completeNarrative(text, facts, lang) {
  const additions = [];
  const visit = visitFault([text.replace(/^\s*(?:-\s+|#{1,6}\s+)/gm, '')], facts.care_level);
  if (facts.care_level !== 'tu_theo_doi' && visit === 'required_referral_missing')
    additions.push(requiredVisit(facts, lang));
  for (const action of requiredActions(facts, lang).slice(1)) {
    const names = requiredMeasurementTypes(facts);
    const present = names.every((type) =>
      (type === 'huyet_ap'
        ? /(?:đo|measure|check).*?(?:huyết áp|blood pressure)/iu
        : /(?:đo|measure|check).*?(?:đường huyết|blood glucose)/iu
      ).test(text)
    );
    if (!present) additions.push(action);
  }
  // Add exact facts from storage when the model's reading sentence was removed.
  for (const type of ['huyet_ap', 'duong_huyet']) {
    const record = currentReading(facts, type);
    if (record && !text.includes(`${record.gia_tri} ${record.don_vi}`))
      additions.push(readingSentence(record, lang));
  }
  return [text, additions.length ? additions.map((item) => `- ${item}`).join('\n') : '']
    .filter(Boolean)
    .join('\n\n');
}

function narrativeSpeech(text, closeMessage, notice, facts, lang) {
  const sentences = [
    ...sentenceSegmenter.segment(
      text
        .replace(/^\s*#{1,6}[^\n]*$/gm, '')
        .replace(/^\s*-\s+/gm, '')
        .replace(/\n/g, ' ')
    ),
  ]
    .map((s) => s.segment.trim())
    .filter(Boolean);
  const warnings = sentences.filter((s) => containsVisit(s) || /(?:gọi|call)\s*115/iu.test(s));
  const required =
    facts.care_level === 'tu_theo_doi' || !visitFault(warnings, facts.care_level)
      ? []
      : [requiredVisit(facts, lang)];
  const selected = [...new Set([...sentences.slice(0, 2), ...required, ...warnings])];
  const suffix = [closeMessage, notice].filter(Boolean).join(' ');
  const body = [];
  for (const sentence of selected)
    if ([...body, sentence, suffix].join(' ').length <= 1600) body.push(sentence);
  return [...body, suffix].join(' ');
}

async function generateNarrativeConclusion(state, profile, lang = 'vi', context = {}) {
  const facts = buildConclusionFacts(state, profile, context, lang);
  const fallback = fallbackBlocks(state, facts, lang);
  const legacy = composeConclusion(fallback, state, profile, lang);
  let narrative,
    source = 'ai';
  const started = Date.now();
  try {
    const response = await callTextAi({
      system: buildNarrativeSystem(facts, lang),
      prompt: buildNarrativePrompt(facts, lang),
      provider: 'medgemma',
      strictProvider: true,
      model: process.env.CHECKIN_CONCLUSION_MODEL || 'medgemma-27b-it',
      temperature: 0.2,
      maxTokens: 8192,
      timeoutMs: 60000,
      maxRetries: 0,
    });
    if (
      typeof response.content !== 'string' ||
      !response.content.trim() ||
      ['[', '{'].includes(response.content.trim()[0])
    )
      throw new Error('invalid_narrative');
    narrative = sanitizeNarrative(response.content, facts);
    if (!narrative || narrative.length < 40) throw new Error('invalid_narrative');
    narrative = completeNarrative(narrative, facts, lang);
    const reason =
      validateBlock('narrative', narrative.replace(/^\s*(?:-\s+|#{1,6}\s+)/gm, ''), facts) ||
      conclusionLanguageFault(narrative, facts);
    if (reason) throw Object.assign(new Error('invalid_narrative'), { reason });
    logger.info('conclusion_generated', {
      format: 'narrative',
      durationMs: Date.now() - started,
      model: response.model,
      tokens: response.usage?.total,
      completionTokens: response.usage?.completion,
      finishReason: response.finishReason,
      fallbackBlocks: 0,
    });
  } catch (error) {
    source = 'fallback';
    narrative = [
      fallback.loi_nhan,
      fallback.lien_quan,
      fallback.nen_lam.map((x) => `- ${x}`).join('\n'),
      fallback.di_kham_khi.map((x) => `- ${x}`).join('\n'),
    ].join('\n\n');
    logger.warn('conclusion_rejected', {
      block: 'narrative',
      reason:
        error.reason ||
        (error.message === 'invalid_narrative' ? 'invalid_narrative' : 'provider_unavailable'),
    });
  }
  return {
    ...legacy,
    conclusionFormat: 'narrative',
    narrative,
    summary: narrative,
    recommendation: [...fallback.nen_lam, ...fallback.di_kham_khi].join('\n'),
    speechText: narrativeSpeech(narrative, legacy.closeMessage, legacy.aiNotice, facts, lang),
    conclusionPromptVersion: facts.chi_tiet_tung_vung?.length
      ? 'v3-narrative-deep-details'
      : 'v3-narrative-deep',
    conclusionRenderVersion: 3,
    conclusionSource: source,
  };
}

module.exports = {
  generateNarrativeConclusion,
  adaptSavedConclusion,
  sanitizeNarrative,
  completeNarrative,
  narrativeSpeech,
};
