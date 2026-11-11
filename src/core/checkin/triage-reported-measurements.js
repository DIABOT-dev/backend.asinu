'use strict';

const { textOf } = require('./triage-facts');

// A quoted answer is a patient report, not a stored/verified vital log. Keep
// that provenance separate and never manufacture a measurement timestamp.
function reportedMeasurements(assessment) {
  if (!assessment) return [];
  const result = [];
  for (const type of ['huyet_ap', 'duong_huyet']) {
    const status = assessment.measurements?.[type];
    const reply = assessment.measurementReplies?.[type] || status;
    if (
      !reply ||
      reply.status !== 'reported' ||
      reply.incompleteValue ||
      reply.evidence?.source === 'health_log' ||
      (status?.code && status.code !== 'reading_available')
    )
      continue;
    const parts = reply.parts || [{ value: reply.value, evidence: reply.evidence }];
    if (
      !parts.length ||
      parts.some(
        (p) =>
          !p.evidence ||
          !Number.isInteger(p.evidence.answerIndex) ||
          typeof p.value !== 'string' ||
          typeof p.evidence.quote !== 'string' ||
          !p.evidence.quote ||
          !textOf(assessment.answers?.[p.evidence.answerIndex]?.answer).includes(
            p.evidence.quote
          ) ||
          !p.evidence.quote.includes(p.value)
      )
    )
      continue;
    const value = parts.map((p) => p.value).join(' ');
    if (value !== reply.value) continue;
    const match =
      type === 'huyet_ap'
        ? value.match(/\b(\d{2,3})\s*\/\s*(\d{2,3})\s*(mmHg)\b/iu)
        : value.match(/\b(\d+(?:[.,]\d+)?)\s*(mmol\s*\/\s*L|mg\s*\/\s*dL)\b/iu);
    if (!match) continue;
    const unit = type === 'huyet_ap' ? 'mmHg' : /^mmol/iu.test(match[2]) ? 'mmol/L' : 'mg/dL';
    const number =
      type === 'huyet_ap'
        ? `${Number(match[1])}/${Number(match[2])}`
        : String(Number(match[1].replace(',', '.')));
    if (number.split('/').some((v) => !Number.isFinite(Number(v)) || Number(v) <= 0)) continue;
    const isYesterday = /hôm qua|yesterday/iu.test(value);
    const today =
      !isYesterday &&
      /hôm nay|today/iu.test(
        `${value} ${status?.value || ''} ${assessment.answers?.[status?.evidence?.answerIndex]?.question || ''}`
      );
    result.push({
      loai: type,
      gia_tri: number,
      don_vi: unit,
      source: 'user_report',
      is_today: today,
      time_text: value,
      evidence: parts.map((p) => p.evidence),
    });
  }
  return result;
}

function clocks(text) {
  const result = [];
  for (const m of text.matchAll(
    /\b(\d{1,2})(?::(\d{2})|\s*(?:h|giờ)\s*(\d{0,2}))(?=$|[^\p{L}\p{N}])/giu
  )) {
    const hour = Number(m[1]),
      minute = Number(m[2] || m[3] || 0);
    if (hour <= 23 && minute <= 59) result.push(`${hour}:${minute}`);
  }
  for (const m of text.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/giu)) {
    if (Number(m[1]) <= 12 && Number(m[2] || 0) <= 59)
      result.push(
        `${(Number(m[1]) % 12) + (m[3].toLowerCase() === 'pm' ? 12 : 0)}:${Number(m[2] || 0)}`
      );
  }
  return result;
}

function reportedMeasurementTimeMatches(text, record) {
  const source = record.time_text;
  if (clocks(text).some((clock) => !clocks(source).includes(clock))) return false;
  if (
    [...text.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?\b/gu)].some(
      (m) => Number(m[1]) <= 31 && Number(m[2]) <= 12 && !source.includes(m[0])
    )
  )
    return false;
  if (/hôm qua|yesterday/iu.test(text) && !/hôm qua|yesterday/iu.test(source)) return false;
  if (/hôm nay|today/iu.test(text) && !record.is_today) return false;
  return true;
}

function reportedMeasurementSentence(record, honorific, lang) {
  const clock = record.time_text.match(/\b(?:[01]?\d|2[0-3]):[0-5]\d\b/u)?.[0];
  const label =
    record.loai === 'huyet_ap'
      ? lang === 'en'
        ? 'blood pressure'
        : 'huyết áp'
      : lang === 'en'
        ? 'blood glucose'
        : 'đường huyết';
  return lang === 'en'
    ? `You reported ${label} of ${record.gia_tri} ${record.don_vi}${clock ? ` at ${clock}` : ''}${record.is_today ? ' today' : ''}.`
    : `${honorific.charAt(0).toUpperCase() + honorific.slice(1)} vừa cho biết ${label} đo được ${record.gia_tri} ${record.don_vi}${clock ? ` lúc ${clock}` : ''}${record.is_today ? ' hôm nay' : ''}.`;
}

module.exports = {
  reportedMeasurements,
  reportedMeasurementTimeMatches,
  reportedMeasurementSentence,
};
