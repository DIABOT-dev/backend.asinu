'use strict';

const { z } = require('zod');
const { callTextAi } = require('../ai/ai.service');
const { logDataSchemas } = require('../../validation/validation.schemas');
const medication = require('./medication-assistant.service');
const tools = require('./app-tools.service');
const profileTools = require('./profile-assistant.service');
const domainTools = require('./domain-tools.service');
const commandScope = require('./skill-router.service');
const readCache = require('./assistant-read-cache.service');
const { requestSchema } = require('./assistant-request.schema');

const { actionSchema, scales } = require('./app-actions.schema');
const responseSchema = z.object({
  status: z.enum(['ready', 'clarify', 'unsupported']),
  question: z.string().max(2000).default(''),
  actions: z.array(actionSchema).max(5).default([]),
}).strict();
const readJson = text => JSON.parse(String(text).trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu, '$1'));

// Check quantities against the actual utterance in addition to model review.
// In particular, never turn a guessed cup size or BP "12/8" into a measurement.
function numbersIn(text) {
  const numbers = (text.match(/\d+(?:[.,]\d+)?/gu) || []).map(value => Number(value.replace(',', '.')));
  const normalized = text.normalize('NFD').replace(/[\u0300-\u036f]/gu, '').replace(/đ/gu, 'd').toLowerCase();
  const digits = { khong: 0, mot: 1, hai: 2, ba: 3, bon: 4, tu: 4, nam: 5, lam: 5, sau: 6, bay: 7, tam: 8, chin: 9 };
  const phrases = normalized.match(/\b(?:khong|mot|hai|ba|bon|tu|nam|lam|sau|bay|tam|chin|muoi|tram|nghin|ngan|linh|le|phay)(?:\s+(?:khong|mot|hai|ba|bon|tu|nam|lam|sau|bay|tam|chin|muoi|tram|nghin|ngan|linh|le|phay))*\b/gu) || [];
  for (const phrase of phrases) {
    const [whole, decimal] = phrase.split(' phay ');
    let total = 0, group = 0, digit = 0;
    for (const word of whole.split(/\s+/u)) {
      if (Object.hasOwn(digits, word)) digit = digits[word];
      else if (word === 'tram') { group += (digit || 1) * 100; digit = 0; }
      else if (word === 'muoi') { group += (digit || 1) * 10; digit = 0; }
      else if (word === 'nghin' || word === 'ngan') { total += (group + digit || 1) * 1000; group = 0; digit = 0; }
    }
    let value = total + group + digit;
    if (decimal) {
      const parts = decimal.split(/\s+/u);
      if (!parts.every(word => Object.hasOwn(digits, word))) continue;
      value += Number(`0.${parts.map(word => digits[word]).join('')}`);
    }
    numbers.push(value);
  }
  return numbers;
}
// Height has its own unit conversion. Applying this to numbersIn would also
// loosen journal/BP checks, where e.g. "12/8" must never become "120/80".
function heightMatches(value, evidence) {
  // Recognize the actual unit before accent folding: "mệt" is not "mét".
  const text = evidence.normalize('NFC').toLowerCase().replace(/(?<!\p{L})(?:mét|met)(?!\p{L})/gu, 'meter')
    .normalize('NFD').replace(/[\u0300-\u036f]/gu, '');
  const meter = '(?:meters?|metres?|m)';
  const centimeter = '(?:centimeters?|centimetres?|xentimet|xang[ -]?ti[ -]?met(?:er)?|cm)';
  const decimal = '\\d+(?:[.,]\\d+)?';
  const word = '(?:khong|mot|hai|ba|bon|tu|nam|lam|sau|bay|tam|chin|muoi|tram|linh|le|phay)';
  const spoken = `${word}(?:\\s+${word})*\\b`;
  const quantity = `(?:${decimal}|${spoken})`;
  const exact = source => /^\d/u.test(source) ? Number(source.replace(',', '.')) : numbersIn(source)[0];
  const values = [], compounds = [];
  // Numeric suffixes without a repeated cm unit must contain two digits:
  // "1m70" is exact; ambiguous shorthand such as "1m7" is not guessed.
  const compound = new RegExp(`(?<![\\p{L}\\d.,])(${quantity})\\s*${meter}(?!\\p{L})(?:\\s*(${quantity})(?:\\s*(${centimeter})(?!\\p{L}))?)?(?!\\d|[.,]\\d)`, 'gu');
  for (const match of text.matchAll(compound)) {
    compounds.push([match.index, match.index + match[0].length]);
    const meters = exact(match[1]);
    if (!Number.isFinite(meters)) continue;
    if (match[2] === undefined) values.push(meters * 100);
    else {
      const cm = exact(match[2]);
      const exactSuffix = match[3] || /^\d{2}$/u.test(match[2]) || !/^\d/u.test(match[2]) && cm >= 10;
      if (Number.isInteger(meters) && Number.isFinite(cm) && cm >= 0 && cm < 100 && exactSuffix) values.push(meters * 100 + cm);
    }
  }
  const centimeters = new RegExp(`(?<![\\p{L}\\d.,])(${quantity})\\s*${centimeter}(?!\\p{L})`, 'gu');
  for (const match of text.matchAll(centimeters)) {
    // The "70 cm" in "1 m 70 cm" is a component, not a second height.
    if (!compounds.some(([start, end]) => match.index >= start && match.index < end)) values.push(exact(match[1]));
  }
  const hasUnit = compounds.length > 0 || new RegExp(`(?:${decimal}\\s*|\\b)${centimeter}(?!\\p{L})`, 'u').test(text);
  if (!hasUnit) {
    // Bare centimeters remain supported next to the height field, but a number
    // attached to a weight/date/age elsewhere is not evidence for this field.
    const bare = new RegExp(`\\b(?:chieu cao|height)(?:\\s+(?:cua|toi|minh|giup|cho|la|thanh|to|is|my))*\\s+(${quantity})(?![\\p{L}\\d]|[.,]\\d)(?!\\s*(?:kg|kilograms?|feet|foot|ft|inches?|inch|tuoi|years?)\\b)`, 'gu');
    for (const match of text.matchAll(bare)) values.push(exact(match[1]));
    if (new RegExp(`^${quantity}$`, 'u').test(text.trim())) values.push(exact(text.trim()));
  }
  if (new Set(values).size > 1 && /\b(hay|hoac|or|either|khong chac|khong nho)\b/u.test(text)) return false;
  return values.some(height => Math.abs(height - value) < 0.000001);
}
function validatePlan(raw, request, medicationContext, profileContext) {
  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success) return null;
  const result = parsed.data;
  if (result.status !== 'ready') return result.actions.length === 0 && result.question.trim() ? result : null;
  if (!result.actions.length || result.question.trim()) return null;
  const source = `${request.clarification?.original || ''}\n${request.text}`;
  const seen = new Set();
  for (const action of result.actions) {
    const key = action.type === 'query' ? `${action.type}:${action.topic}:${action.range}:${action.statistic}:${action.startDate || ''}:${action.endDate || ''}` : action.type === 'app_tool' ? `${action.type}:${action.tool}:${JSON.stringify(action.parameters)}` : action.type;
    if ((!medication.isMedication(action) && seen.has(key)) ||
      !source.replace(/\s+/g, ' ').includes(action.evidence.replace(/\s+/g, ' '))) return null;
    seen.add(key);
    const numbers = numbersIn(action.evidence);
    if (action.type === 'app_tool') {
      try { domainTools.parse(action); } catch { return null; }
      if (action.tool === 'medication.purpose' && (!medication.purposeSelectionMatches(action.parameters.tags || [], source) ||
        action.parameters.mode === 'clear' && !/\b(tat ca|toan bo|het tag|all|no tags|without tags)\b/.test(require('./domain-tools.read').fold(source)))) return null;
      // An unqualified latest result spans all dates. A model-added TODAY must
      // not hide the last completed result when today's interview is unfinished.
      if (action.tool === 'checkin.conclusion' && action.parameters.date) {
        const words = source.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').toLowerCase();
        if (/\b(gan nhat|moi nhat|latest|last)\b/.test(words) && !/\d|\b(hom nay|hom qua|ngay|thang|nam|today|yesterday|on|from|since|before|after)\b/.test(words))
          delete action.parameters.date;
      }
      if (action.tool === 'family.invite' && !source.replace(/\s/g, '').includes(action.parameters.phone)) return null;
      if (action.tool === 'wallet.topup' && !numbers.includes(action.parameters.amount)) {
        const words = action.evidence.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').toLowerCase();
        const formatted = [...words.matchAll(/\b\d{1,3}(?:[.,]\d{3})+\b/g)].map(match => Number(match[0].replace(/[.,]/g, '')));
        const converted = [...formatted, ...[...words.matchAll(/(\d+(?:[.,]\d+)?)\s*(nghin|ngan|trieu|k|thousand|million)\b/g)].map(match => Number(match[1].replace(',', '.')) * (/trieu|million/.test(match[2]) ? 1000000 : 1000))];
        const digits = { mot: 1, hai: 2, ba: 3, bon: 4, nam: 5, sau: 6, bay: 7, tam: 8, chin: 9 };
        for (const match of words.matchAll(/\b(mot|hai|ba|bon|nam|sau|bay|tam|chin)\s+(trieu|nghin|ngan)\b/g)) converted.push(digits[match[1]] * (match[2] === 'trieu' ? 1000000 : 1000));
        if (!converted.includes(action.parameters.amount)) return null;
      }
    } else if (action.type === 'query' && action.range === 'custom' && (!action.startDate || !action.endDate || action.endDate < action.startDate || (Date.parse(action.endDate) - Date.parse(action.startDate)) / 86400000 > 365)) return null;
    else if (action.type === 'meal') {
      if (!source.toLowerCase().includes(action.meal_text.toLowerCase()) || !logDataSchemas.meal.safeParse(action).success ||
        ['calories_kcal', 'carbs_g', 'protein_g', 'fat_g'].some(key => action[key] !== undefined && !numbers.includes(action[key]))) return null;
    } else if (medication.isMedication(action)) {
      if (!medication.validateAction(action, medicationContext, source)) return null;
    } else if (action.type === 'profile') {
      const fold = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      if (action.changes.heightCm !== undefined && !heightMatches(action.changes.heightCm, action.evidence)) return null;
      if (action.changes.bloodType && !source.toUpperCase().includes(action.changes.bloodType)) return null;
      if (action.changes.name && !fold(source).includes(fold(action.changes.name))) return null;
      if (action.changes.chronicDiseases && profileContext?.chronicDiseases?.length) {
        const existing = profileContext.chronicDiseases;
        const sourceText = fold(source).replace(/đ/g, 'd');
        if (/\b(them|bo sung|add|also)\b/.test(sourceText))
          action.changes.chronicDiseases = [...new Set([...existing, ...action.changes.chronicDiseases])];
        const removed = existing.filter(value => !action.changes.chronicDiseases.includes(value));
        if (removed.length && (!/\b(xoa|bo|khong con|het|thay|chi con|remove|clear|replace|no longer)\b/.test(sourceText) ||
          (!/\b(tat ca|toan bo|all|entire)\b/.test(sourceText) && removed.some(value => !fold(source).includes(fold(value)))))) return null;
      }
      if (action.changes.chronicDiseases?.some(value => !(profileContext?.chronicDiseases || []).includes(value) && !fold(source).includes(fold(value)))) return null;
    } else if (action.type === 'font_size') {
      if (action.value === 'increase' || action.value === 'decrease') {
        const offset = action.value === 'increase' ? 1 : -1;
        action.value = scales[Math.max(0, Math.min(scales.length - 1, scales.indexOf(request.current.fontSize) + offset))];
      }
    } else if (action.type === 'glucose') {
      if (!numbers.includes(action.value) || !logDataSchemas.glucose.safeParse(action).success) return null;
    } else if (action.type === 'blood_pressure') {
      if (![action.systolic, action.diastolic, ...(action.pulse === undefined ? [] : [action.pulse])].every(n => numbers.includes(n)) ||
        !logDataSchemas.bp.safeParse({ ...action, unit: 'mmHg' }).success) return null;
      if (action.pulse !== undefined) {
        const words = source.normalize('NFD').replace(/[\u0300-\u036f]/gu, '').toLowerCase().replace(/đ/gu, 'd');
        const pulseMentioned = /\b(nhip|pulse|bpm|heart rate|beats?)\b|lan\s*\/\s*phut/u.test(words);
        const triples = [...words.matchAll(/\b(\d{2,3})\s*\/\s*(\d{2,3})\s*\/\s*(\d{2,3})\b/gu)];
        if (!pulseMentioned && !triples.some(match => Number(match[1]) === action.systolic && Number(match[2]) === action.diastolic && Number(match[3]) === action.pulse)) return null;
      }
    } else if (action.type === 'water') {
      const litres = /(?:\bl(?:it(?:er|re)?s?)?\b|lít)/iu.test(action.evidence) && !/\bml\b|mi.li.l[ií]t/iu.test(action.evidence);
      if (!numbers.some(n => Math.abs(n * (litres ? 1000 : 1) - action.volume_ml) < 0.001) ||
        !logDataSchemas.water.safeParse(action).success) return null;
    }
  }
  return result;
}

async function plan(input, lang = 'vi', { pool, userId, signal } = {}) {
  signal?.throwIfAborted();
  let contextCompacted = false;
  const invokeModel = async options => {
    signal?.throwIfAborted();
    const result = await callTextAi({ ...options, ...(signal ? { signal } : {}) });
    signal?.throwIfAborted();
    return result;
  };
  const callModel = async options => {
    if (contextCompacted) {
      const prompt = commandScope.compactReadContext(options.prompt);
      return invokeModel(prompt ? { ...options, prompt } : options);
    }
    try {
      return await invokeModel(options);
    } catch (error) {
      signal?.throwIfAborted();
      if (error?.code !== 'AI_CONTEXT_LIMIT') throw error;
      const prompt = commandScope.compactReadContext(options.prompt);
      if (!prompt) throw error;
      contextCompacted = true;
      return invokeModel({ ...options, prompt });
    }
  };
  const checked = requestSchema.safeParse(input);
  if (!checked.success) throw Object.assign(new Error('Invalid assistant request'), { code: 'APP_ASSISTANT_INVALID_REQUEST', statusCode: 400 });
  const request = checked.data;
  // Tool results may contain a relative's shared health data. The next model
  // turn needs prior USER requests to resolve the topic, not those private results.
  if (request.conversation) request.conversation = request.conversation.filter(message => message.role === 'user');
  let medicationContext = commandScope.noMedContext();
  let medicationLoaded = false;
  // A fully parsed, explicit command needs no model to restate or approve it.
  // Keep the same validators, signed medication capability and confirmation UI.
  const explicit = commandScope.explicitCommand(request);
  if (explicit) {
    if (medication.isMedication(explicit)) {
      medicationContext = await medication.contextForPlan(pool, userId);
      medicationLoaded = true;
      if (!medicationContext.available) return { status: 'clarify', actions: [], question: lang === 'en' ? 'Medication reminders are not enabled for this account.' : 'Tính năng nhắc thuốc hiện chưa được bật cho tài khoản này.' };
      const question = medication.policyQuestion([explicit], request, medicationContext, lang);
      if (question) return { status: 'clarify', actions: [], question };
    }
    const direct = validatePlan({ status: 'ready', actions: [explicit] }, request, medicationContext);
    signal?.throwIfAborted();
    if (direct) return medication.isMedication(explicit)
      ? { ...direct, actions: [await medication.prepareWithPurpose(pool, direct.actions, medicationContext, userId, request.text, { signal })] }
      : direct;
  }
  let ids = commandScope.select(request);
  const clarification = () => ({ status: 'clarify', actions: [], question: lang === 'en'
    ? 'Please describe the app action you want and its exact details.'
    : 'Bạn nói rõ hơn thao tác muốn làm và thông tin cần dùng giúp mình nhé.' });
  if (!ids.length) {
    const routed = await commandScope.route(request, callModel, lang);
    if (routed?.question) return { status: 'clarify', actions: [], question: routed.question };
    ids = routed?.skills;
  }
  if (!commandScope.validIds(ids)) return clarification();
  let profileContext = null, profileLoaded = false, candidate, approved = false;
  // At most one expansion, always before preparation. No unbounded model loop
  // and no fallback that silently sends every instruction/context to the model.
  for (let attempt = 0; attempt < 2; attempt++) {
    signal?.throwIfAborted();
    const needed = commandScope.contextFor(ids, request);
    if (needed.medication && !medicationLoaded) {
      medicationContext = await medication.contextForPlan(pool, userId);
      medicationLoaded = true;
    }
    if (needed.profile && !profileLoaded) {
      profileContext = await tools.profileContext(pool, userId);
      profileLoaded = true;
    }
    const prompts = commandScope.prompts(ids, request);
    const modelInput = commandScope.inputForModel(request, ids);
    const modelContext = {
      ...(needed.medication ? { MEDICATION_CONTEXT: medication.modelContext(medicationContext) } : {}),
      ...(needed.profile ? { PROFILE_CONTEXT: { chronicDiseases: profileContext?.chronicDiseases || [] } } : {}),
    };
    const response = await callModel({ provider: 'medgemma', strictProvider: true,
      model: process.env.APP_ASSISTANT_MODEL || 'medgemma-27b-it', system: prompts.system,
      prompt: JSON.stringify({ TODAY: require('../v21/common').localDate(), LANG: lang, INPUT: modelInput, ...modelContext }),
      jsonMode: true, temperature: 0, maxTokens: ids.length > 2 ? 1600 : 900, timeoutMs: 90000, maxRetries: 0 });
    let raw;
    try { raw = readJson(response.content); } catch { return clarification(); }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return clarification();
    if (raw.status === 'route') {
      const next = commandScope.expand(ids, raw.skills);
      if (!attempt && next) { ids = next; continue; }
      return clarification();
    }
    try {
      // One observed spelling alias; this cannot extend the capability set.
      if (Array.isArray(raw.actions)) for (const action of raw.actions)
        if (action.type === 'app_tool' && action.tool === 'app_guide') action.tool = 'app.guide';
      raw = commandScope.decode(raw, ids, request);
      if (raw.status === 'ready' && (!Array.isArray(raw.actions) || !commandScope.accepts(ids, raw.actions))) return clarification();
      if (raw.status === 'ready' && raw.actions.some(medication.isMedication) && !medicationLoaded) {
        medicationContext = await medication.contextForPlan(pool, userId);
        medicationLoaded = true;
      }
      if (raw.status === 'ready' && raw.actions.some(medication.isMedication) && !medicationContext.available)
        return { status: 'clarify', actions: [], question: lang === 'en' ? 'Medication reminders are not enabled for this account.' : 'Tính năng nhắc thuốc hiện chưa được bật cho tài khoản này.' };
      if (raw.status === 'ready' && raw.actions.some(action => action.type === 'profile') && !profileLoaded) {
        profileContext = await tools.profileContext(pool, userId);
        profileLoaded = true;
      }
      const question = raw.status === 'ready' && medication.policyQuestion(raw.actions, request, medicationContext, lang);
      if (question) return { status: 'clarify', actions: [], question };
      candidate = validatePlan(raw, request, medicationContext, profileContext);
      if (candidate && !commandScope.accepts(ids, candidate.actions)) candidate = null;
    } catch { candidate = null; }
    if (!candidate) return clarification();
    if (candidate.status !== 'ready') return candidate;
    let reviewSystem;
    try { reviewSystem = commandScope.reviewPrompt(ids, candidate.actions); } catch { return clarification(); }
    const review = await callModel({ provider: 'medgemma', strictProvider: true,
      model: process.env.APP_ASSISTANT_MODEL || 'medgemma-27b-it', system: reviewSystem,
      prompt: JSON.stringify({ INPUT: modelInput, PREVIEW: candidate.actions,
        ...(candidate.actions.some(action => medication.isMedication(action) && action.type !== 'medication_create') ? { MEDICATION_CONTEXT: medication.modelContext(medicationContext) } : {}),
        ...(candidate.actions.some(action => action.type === 'profile' && action.changes.chronicDiseases) ? { PROFILE_CONTEXT: { chronicDiseases: profileContext?.chronicDiseases || [] } } : {}),
      }),
      jsonMode: true, temperature: 0, maxTokens: 90, timeoutMs: 45000, maxRetries: 0 });
    let result;
    try { result = readJson(review.content); } catch { return clarification(); }
    approved = result.approved === true;
    if (approved) break;
    const next = commandScope.expand(ids, result.skills);
    if (!attempt && next) { ids = next; continue; }
    break;
  }
  if (approved) {
    const approvedActions = candidate.actions;
    const answers = [];
    const actions = [];
    for (const action of candidate.actions) {
      signal?.throwIfAborted();
      if (action.type === 'app_tool') {
        const prepared = await domainTools.prepare(pool, userId, action, lang, { hiddenArticles: request.hiddenArticles || [], allowCuratedArticles: request.allowCuratedArticles !== false, ...(signal ? { signal } : {}) });
        if (prepared.clarify) return { status: 'clarify', actions: [], question: prepared.clarify.slice(0, 2000) };
        if (prepared.answer) answers.push(prepared.answer);
        if (prepared.action) actions.push(prepared.action);
        if (prepared.native) actions.push(prepared.native);
        if (prepared.screen) actions.push({ type: 'screen', ...prepared.screen });
        if (prepared.speech) actions.push({ type: 'speech', text: prepared.speech });
      } else if (action.type === 'query') answers.push(await tools.query(pool, userId, action, lang));
      else if (action.type === 'profile') actions.push(profileTools.prepare(action, profileContext, userId));
      else if (action.type === 'routine_reminders') {
        const prepared = await tools.prepareReminders(pool, userId, action, lang, { signal });
        if (prepared.status === 'clarify') return { status: 'clarify', actions: [], question: prepared.question };
        actions.push(prepared);
      } else actions.push(action);
      signal?.throwIfAborted();
    }
    candidate = { ...candidate, actions, ...(answers.length ? { answer: answers.join('\n\n') } : {}) };
    if (!actions.length) {
      const result = { ...candidate, status: 'answer' };
      const capability = readCache.issue(request, approvedActions, result, userId, lang);
      return capability ? { ...result, readCache: capability } : result;
    }
  }
  if (approved && candidate.actions.some(medication.isMedication)) {
    let action;
    try { action = await medication.prepareWithPurpose(pool, candidate.actions, medicationContext, userId, `${request.clarification?.original || ''}\n${request.text}`, { signal }); }
    catch (error) {
      signal?.throwIfAborted();
      if (error.code === 'MED_TAG_NOT_VERIFIED') return { status: 'clarify', actions: [], question: lang === 'en'
        ? 'The source has not verified those purpose tags. Please check the full medicine name, or request the reminder without tags.'
        : 'Nguồn tra cứu chưa xác nhận các tag này. Bạn kiểm tra tên thuốc đầy đủ, hoặc yêu cầu tạo lịch không gắn tag nhé.' };
      if (error.code === 'MED_TAG_EDIT_SEPARATELY') return { status: 'clarify', actions: [], question: lang === 'en'
        ? 'This medicine is already saved. Please request its purpose-tag change separately from adding a reminder time.'
        : 'Thuốc này đã có trong danh sách. Bạn yêu cầu đổi tag công dụng riêng với thao tác thêm giờ nhắc nhé.' };
      approved = false;
    }
    if (approved) return { ...candidate, actions: [...candidate.actions.filter(action => !medication.isMedication(action)), action] };
  }
  return approved ? candidate : { status: 'clarify', actions: [], question: lang === 'en'
    ? 'Please confirm the exact setting or the reading and unit you want to save.'
    : 'Bạn xác nhận lại giúp mình cài đặt muốn đổi hoặc số đo và đơn vị cần ghi nhé.' };
}

module.exports = { plan, validatePlan, requestSchema, numbersIn };
