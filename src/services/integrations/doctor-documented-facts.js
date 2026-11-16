const { clinicalConversation } = require('./doctor-conversation-context');

const patientTurns = (context) => {
  const turns = clinicalConversation(context);
  const initial = context.initial_patient_statement;
  if (
    initial?.message &&
    !turns.some((turn) => turn.role === 'patient' && turn.message === initial.message)
  )
    turns.unshift({ role: 'patient', message: initial.message });
  const latest = context.latest_patient_message;
  if (
    latest?.message &&
    !turns.some((turn) => turn.role === 'patient' && turn.message === latest.message)
  )
    turns.push({ role: 'patient', message: latest.message });
  return turns;
};

const noMedicines =
  /(?:không|chưa)\s+(?:có\s+)?(?:đang\s+)?(?:dùng|uống|sử dụng)\s+(?:bất kỳ\s+)?thuốc(?:\s+gì(?:\s+cả)?|\s+nào)?(?:\s*(?:cả|hết))?\s*(?:[,.!;]|$)|(?:not taking|take no|do not take|don't take)\s+(?:any\s+)?(?:medicines?|medications?)\b/iu;
const medicationMention =
  /(?:dùng|uống|sử dụng).{0,20}thuốc|(?:taking|take).{0,15}(?:medicine|medication)/iu;
const nauseaDenial =
  /(?:không|chưa)\s+(?:có\s+|bị\s+|thấy\s+)?(?:(?:sốt|nôn(?: ói)?|ói|đau đầu|chóng mặt)\s*(?:,|\/|và|hoặc|hay)\s*)*(?:(?:và|hoặc|hay)\s+)?buồn nôn|(?:no|without|denies?)\s+(?:(?:fever|vomiting|headache|dizziness)\s*(?:,|\/|and|or)\s*)*(?:(?:and|or)\s+)?nausea|not\s+nauseous/iu;
const nauseaTopic = /buồn nôn|nausea|nauseous/iu;
const uncertainty =
  /không (?:rõ|biết|chắc|nhớ)|chưa (?:rõ|biết|chắc)|not sure|don'?t know|unsure/iu;
const shortDenial = /^(?:dạ\s+)?(?:không|chưa)(?:\s+ạ)?[.!\s]*$|^no[.!\s]*$/iu;
const statedAges = (text) =>
  [...String(text).matchAll(/\b(\d{1,3})\s*(?:tuổi|years? old)\b|\baged?\s+(\d{1,3})\b/giu)].map(
    (match) => Number(match[1] || match[2])
  );

const clauses = (text) =>
  String(text || '')
    .split(/[.!;\n]|(?:nhưng|tuy nhiên|however|\bbut\b)/iu)
    .map((part) => part.trim())
    .filter(Boolean);
const isUnasserted = (text) =>
  /[?？]/u.test(text) ||
  /(?:^|[^\p{L}])(?:nếu|if)(?:$|[^\p{L}])/iu.test(text) ||
  /^(?:Theo (?:nguồn|tài liệu|hướng dẫn)|Nguồn|Tài liệu|Hướng dẫn|NHS|According to|The source|The guideline)/iu.test(
    text
  ) ||
  /(?:^|[,:]\s*)(?:nếu|if|theo dõi|monitor|hỏi|cần (?:hỏi|xác nhận|khai thác))/iu.test(text) ||
  /chưa (?:có thông tin|được hỏi|rõ|biết|chắc)(?!\s+(?:tại sao|vì sao|nguyên nhân))|không (?:rõ|biết|chắc|nhớ)(?!\s+(?:tại sao|vì sao|nguyên nhân))|not (?:reported|documented)|unknown|uncertain|not sure(?!\s+why)|whether/iu.test(
    text
  );
const singleNauseaQuestion = (text) =>
  nauseaTopic.test(text) &&
  !/sốt|nôn|ói|vomit|fever|thuốc|dị ứng|\bhay\b|\bor\b/iu.test(
    text.replace(/buồn nôn|nausea|nauseous/giu, '')
  );
const nauseaStateIn = (text) => {
  let state = 'unknown';
  for (const clause of clauses(text)) {
    if (!nauseaTopic.test(clause) || isUnasserted(clause)) continue;
    state = nauseaDenial.test(clause) ? 'absent' : 'present';
  }
  return state;
};
const nauseaState = (context) => {
  const turns = patientTurns(context);
  let state = 'unknown';
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index];
    if (turn.role !== 'patient') continue;
    if (nauseaTopic.test(turn.message)) state = nauseaStateIn(turn.message);
    const previous = turns[index - 1];
    if (previous?.role === 'doctor' && singleNauseaQuestion(previous.message)) {
      if (shortDenial.test(turn.message)) state = 'absent';
      if (/^(?:dạ\s+)?(?:có|yes)(?:\s+ạ)?[.!\s]*$/iu.test(turn.message)) state = 'present';
    }
  }
  return state;
};
const mealPainState = (text) => {
  let state = 'unknown';
  for (const clause of clauses(text).flatMap((part) => part.split(','))) {
    if (isUnasserted(clause)) continue;
    const match =
      /(?:đau|pain).{0,55}(?:sau (?:khi )?ăn|ăn xong|after (?:eating|meals))|(?:sau (?:khi )?ăn|ăn xong|after (?:eating|meals)).{0,35}(?:đau|pain)/iu.exec(
        clause
      );
    if (!match || /đầy|bloating|fullness/iu.test(match[0])) continue;
    state = /không|chưa|\bno\b|\bnot\b/iu.test(clause) ? 'absent' : 'present';
  }
  return state;
};
const documentedFacts = (context) => {
  const turns = patientTurns(context);
  let noCurrentMedicines = false;
  let painAfterMeals = false;
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index];
    if (turn.role !== 'patient') continue;
    const text = turn.message;
    const previous = turns[index - 1];
    // An explicitly separate allergy clause does not make the preceding
    // medication answer uncertain: "no medicines, unsure about allergies".
    for (const clause of clauses(text).flatMap((part) =>
      part.split(/,(?=[^,]{0,100}(?:dị ứng|allerg))/iu)
    )) {
      if (medicationMention.test(clause))
        noCurrentMedicines = !uncertainty.test(clause) && noMedicines.test(clause);
    }
    if (
      previous?.role === 'doctor' &&
      shortDenial.test(text) &&
      /(?:đang|hiện).{0,15}(?:dùng|uống).{0,10}thuốc|taking.{0,15}medication/iu.test(
        previous.message
      ) &&
      !/giảm đau|painkiller|dị ứng|allerg|bệnh nền|\bvà\b|\band\b/iu.test(previous.message) &&
      (previous.message.match(/[?？]/gu) || []).length <= 1
    )
      noCurrentMedicines = true;
    const relationship = mealPainState(text);
    if (relationship !== 'unknown') painAfterMeals = relationship === 'present';
  }
  return { noCurrentMedicines, noNausea: nauseaState(context) === 'absent', painAfterMeals };
};

const reconcileMissingData = (context, missing) => {
  const facts = documentedFacts(context);
  return missing.filter(
    (item) =>
      !(
        facts.noCurrentMedicines &&
        /thuốc|medication|medicine/iu.test(item) &&
        !/trước đây|tiền sử|previous|past|dị ứng|allerg/iu.test(item)
      )
  );
};

const unsupportedDocumentedClaims = (context, output) => {
  const facts = documentedFacts(context);
  const summary = [
    output.clinical_summary,
    output.clinical_rationale,
    ...Object.values(output.soap_note || {}),
    output.patient_reply,
    output.follow_up_draft,
  ]
    .filter(Boolean)
    .join('\n');
  const asserted = clauses(summary)
    .filter((clause) => !isUnasserted(clause))
    .join('\n');
  const errors = [];
  if (
    /không (?:có |ghi nhận )?(?:bất kỳ )?(?:các )?dấu hiệu (?:cấp tính|nguy hiểm|cấp cứu)|no (?:acute signs|red flags|danger signs)/iu.test(
      asserted
    )
  )
    errors.push(
      'Do not rule out all acute or dangerous signs from an incomplete remote history. State only the specific negatives actually reported by the patient and attribute them to that report.'
    );
  const knownAges = new Set(
    patientTurns(context)
      .filter((turn) => turn.role === 'patient')
      .flatMap((turn) => statedAges(turn.message))
  );
  if (Number.isFinite(context.profile?.age)) knownAges.add(context.profile.age);
  if (statedAges(asserted).some((age) => !knownAges.has(age)))
    errors.push(
      'Do not invent an exact patient age. When only birth_year is documented, state that birth year instead of calculating or guessing an age.'
    );
  const knownNausea = nauseaState(context);
  if (
    clauses(asserted).some((clause) => {
      if (/trước đó|trước đây|hôm qua|previously|earlier/iu.test(clause)) return false;
      const claimed = nauseaStateIn(clause);
      return claimed !== 'unknown' && claimed !== knownNausea;
    })
  )
    errors.push(
      'Do not assert presence or absence of nausea without a matching patient statement. A denial of vomiting is not a denial of nausea. Keep unreported nausea unknown.'
    );
  if (!facts.painAfterMeals && mealPainState(asserted) === 'present')
    errors.push(
      'Do not assert pain starts or worsens after eating unless the patient documented that relation. Post-meal fullness alone is not post-meal pain.'
    );
  return errors;
};

module.exports = { documentedFacts, reconcileMissingData, unsupportedDocumentedClaims };
