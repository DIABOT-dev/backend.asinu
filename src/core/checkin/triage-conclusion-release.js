'use strict';

const { t } = require('../../i18n');
const { capitalizeSentences } = require('../../lib/text-format');

// AC-9 requires expert review of the samples and P6 approval of the disclaimer
// before the structured conclusion is released to real users.
function structuredConclusionEnabled(env = process.env) {
  const value = env.CHECKIN_STRUCTURED_CONCLUSION_ENABLED;
  if (value !== undefined) return value === 'true' || value === '1';
  return env.NODE_ENV === 'development' || env.NODE_ENV === 'test';
}

// Preserve the pre-SRS, server-authored result while the new content is pending
// review. Do not invoke the new model or expose its six-block response here.
function legacyConclusion(state, h, lang) {
  const symptoms = (
    state.newSymptoms && state.currentSymptoms?.length
      ? state.currentSymptoms
      : state.allSymptoms || []
  ).join(', ');
  let summary = t('checkin.triage.conclusion.insufficient', lang, h);
  if (symptoms) {
    const details = [symptoms];
    if (state.onset)
      details.push(t('checkin.triage.conclusion.onset', lang, { onset: state.onset }));
    if (state.progression) details.push(t(`checkin.triage.conclusion.${state.progression}`, lang));
    summary = t('checkin.triage.conclusion.recorded', lang, { ...h, details: details.join('; ') });
    if (state.newSymptoms && state.baselineSymptoms?.length)
      summary += ` ${t('checkin.triage.conclusion.previous', lang, {
        ...h,
        symptoms: state.baselineSymptoms.join(', '),
      })}`;
    if (state.assessmentIncomplete)
      summary += ` ${t('checkin.triage.conclusion.insufficient', lang, h)}`;
  }
  const tier = state.needsDoctor ? 'doctor' : state.severity === 'medium' ? 'medium' : 'low';
  return {
    summary: capitalizeSentences(summary),
    recommendation: capitalizeSentences(
      t(`checkin.triage.fallback.${tier}.recommendation`, lang, h)
    ),
    closeMessage: capitalizeSentences(
      t('checkin.triage.conclusion.close', lang, {
        ...h,
        hours: state.followUpHours || (state.isElderly ? 4 : 6),
      })
    ),
    isEmergency: false,
  };
}

module.exports = { structuredConclusionEnabled, legacyConclusion };
