'use strict';

/**
 * Script Service — CRUD + Generation + Caching
 *
 * Manages the lifecycle of triage scripts:
 *   1. Onboarding → creates problem_clusters from user's health profile
 *   2. Generate scripts from clinical-mapping (deterministic, no AI)
 *   3. Cache scripts in triage_scripts table
 *   4. API: getUserScript() → returns cached script for current clusters
 *   5. R&D cycle can regenerate/optimize scripts nightly
 *
 * AI is ONLY called when:
 *   - R&D cycle creates scripts for NEW clusters (fallback → cluster)
 *   - Future: MedGemma generates enhanced scripts
 */

const { symptomMap, resolveComplaint, listComplaints } = require('./clinical-mapping');
const { validateScript } = require('../../core/checkin/script-runner');
const { getHonorifics } = require('../../lib/honorifics');

// ─── Cluster key mapping ────────────────────────────────────────────────────
// Maps Vietnamese display names to cluster keys

const CLUSTER_KEY_MAP = {
  'đau đầu': 'headache',
  'đau bụng': 'abdominal_pain',
  'chóng mặt': 'dizziness',
  'mệt mỏi': 'fatigue',
  'đau ngực': 'chest_pain',
  'khó thở': 'dyspnea',
  'đau lưng': 'back_pain',
  'đau khớp': 'joint_pain',
  'mất ngủ': 'insomnia',
  'sốt': 'fever',
  'ho': 'cough',
  'buồn nôn': 'nausea',
  'tiêu chảy': 'diarrhea',
  'táo bón': 'constipation',
  'phát ban': 'rash',
  'đau vai': 'shoulder_pain',
  'đau cổ': 'neck_pain',
  'đau cổ vai gáy': 'neck_pain',
  'tức ngực': 'chest_tightness',
  'huyết áp cao': 'hypertension',
  'đường huyết cao': 'hyperglycemia',
  'đau dạ dày': 'gastric_pain',
  'ợ nóng': 'heartburn',
  'lo lắng': 'anxiety',
  'căng thẳng': 'stress',
};

/**
 * Convert Vietnamese symptom name to cluster key.
 */
function toClusterKey(symptomName) {
  const lower = (symptomName || '').toLowerCase().trim();
  if (CLUSTER_KEY_MAP[lower]) return CLUSTER_KEY_MAP[lower];

  // Try resolving via clinical-mapping
  const resolved = resolveComplaint(lower);
  if (resolved) {
    return CLUSTER_KEY_MAP[resolved.key] || resolved.key.replace(/\s+/g, '_');
  }

  // Fallback: slugify
  return lower.replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
}

// ─── Create clusters from onboarding ────────────────────────────────────────

/**
 * Create problem clusters for a user based on their onboarding symptoms.
 * Called once during onboarding completion.
 *
 * @param {object} pool
 * @param {number} userId
 * @param {string[]} symptoms - e.g. ['đau đầu', 'chóng mặt', 'đau cổ vai gáy']
 * @returns {Promise<object[]>} created clusters
 */
async function createClustersFromOnboarding(pool, userId, symptoms) {
  const clusters = [];

  for (let i = 0; i < symptoms.length; i++) {
    const symptom = symptoms[i];
    const clusterKey = toClusterKey(symptom);
    const displayName = symptom;

    try {
      const { rows } = await pool.query(
        `INSERT INTO problem_clusters (user_id, cluster_key, display_name, source, priority)
         VALUES ($1, $2, $3, 'onboarding', $4)
         ON CONFLICT (user_id, cluster_key) DO UPDATE SET
           display_name = $3, is_active = TRUE, updated_at = NOW()
         RETURNING *`,
        [userId, clusterKey, displayName, symptoms.length - i]  // higher priority for first symptoms
      );
      clusters.push(rows[0]);
    } catch (err) {
      console.error(`[ScriptService] Failed to create cluster ${clusterKey}:`, err.message);
    }
  }

  // Generate initial scripts for all clusters
  for (const cluster of clusters) {
    try {
      await generateScriptForCluster(pool, userId, cluster);
    } catch (err) {
      console.error(`[ScriptService] Failed to generate script for ${cluster.cluster_key}:`, err.message);
    }
  }

  return clusters;
}

// ─── Generate script from clinical-mapping ──────────────────────────────────

/**
 * Generate a triage script for a specific cluster.
 * Uses clinical-mapping data — NO AI calls.
 *
 * @param {object} pool
 * @param {number} userId
 * @param {object} cluster - problem_clusters row
 * @returns {Promise<object>} triage_scripts row
 */
async function generateScriptForCluster(pool, userId, cluster) {
  const resolved = resolveComplaint(cluster.display_name);

  let scriptData;
  if (resolved) {
    scriptData = _buildScriptFromMapping(resolved.key, resolved.data, cluster);
  } else {
    scriptData = _buildGenericScript(cluster);
  }

  // Validate
  const { valid, errors } = validateScript(scriptData);
  if (!valid) {
    console.error(`[ScriptService] Invalid script for ${cluster.cluster_key}:`, errors);
  }

  // Deactivate old scripts for this cluster
  await pool.query(
    `UPDATE triage_scripts SET is_active = FALSE, updated_at = NOW()
     WHERE user_id = $1 AND cluster_key = $2 AND script_type = 'initial' AND is_active = TRUE`,
    [userId, cluster.cluster_key]
  );

  // Insert new script
  const { rows } = await pool.query(
    `INSERT INTO triage_scripts (user_id, cluster_id, cluster_key, script_type, script_data, generated_by)
     VALUES ($1, $2, $3, 'initial', $4::jsonb, 'system')
     RETURNING *`,
    [userId, cluster.id, cluster.cluster_key, JSON.stringify(scriptData)]
  );

  // Also generate follow-up script
  const followUpData = _buildFollowUpScript(cluster);
  await pool.query(
    `INSERT INTO triage_scripts (user_id, cluster_id, cluster_key, script_type, script_data, generated_by)
     VALUES ($1, $2, $3, 'followup', $4::jsonb, 'system')
     ON CONFLICT DO NOTHING`,
    [userId, cluster.id, cluster.cluster_key, JSON.stringify(followUpData)]
  );

  return rows[0];
}

/**
 * Add honorific placeholders to clinical-mapping questions.
 * "Mệt mỏi kéo dài bao lâu rồi?" → "{Honorific} mệt mỏi kéo dài bao lâu rồi?"
 * "Bạn có thêm triệu chứng nào?" → "{Honorific} có thêm triệu chứng nào không?"
 */
function _addHonorifics(question) {
  if (!question) return question;
  let q = question;

  // Already has placeholder → skip
  if (q.includes('{Honorific}') || q.includes('{honorific}')) return q;

  // Replace "Bạn" at start → {Honorific}
  q = q.replace(/^Bạn /, '{Honorific} ');

  // If question starts with symptom name (no subject), add {Honorific} prefix
  // "Mệt mỏi kéo dài..." → "{Honorific} mệt mỏi kéo dài..."
  // "Đau đầu ở vị trí nào?" → "{Honorific} đau đầu ở vị trí nào?"
  // "Kiểu đau như thế nào?" → "{Honorific} thấy kiểu đau như thế nào?"
  // "Giấc ngủ của bạn..." → "Giấc ngủ của {honorific}..."
  if (!q.startsWith('{')) {
    const startsWithVerb = /^(Có |Từ |Khi |Đã |Đang )/i.test(q);
    const isHowQuestion = /^(Kiểu|Mức độ|Tình trạng)/i.test(q);
    const isAboutQuestion = /^(Giấc ngủ|Nhiệt độ|Chất nôn)/i.test(q);
    const isSpecificQ = /ở vị trí|xuất hiện khi|kéo dài bao|ảnh hưởng|liên quan|lan ra|nặng hơn khi/i.test(q);

    if (isAboutQuestion) {
      // "Giấc ngủ của bạn..." → "{Honorific} ngủ gần đây thế nào?"
      // Keep as is, just add {Honorific} + remove "bạn"
      q = `{Honorific} ` + q.charAt(0).toLowerCase() + q.slice(1);
    } else if (isHowQuestion) {
      q = `{Honorific} thấy ` + q.charAt(0).toLowerCase() + q.slice(1);
    } else if (startsWithVerb) {
      q = `{Honorific} ` + q.charAt(0).toLowerCase() + q.slice(1);
    } else if (isSpecificQ) {
      // Already specific: "Đau đầu ở vị trí nào?" → just add subject
      q = `{Honorific} ` + q.charAt(0).toLowerCase() + q.slice(1);
    } else {
      // Default: add "{Honorific}" as subject
      q = `{Honorific} ` + q.charAt(0).toLowerCase() + q.slice(1);
    }
  }

  // Replace "của bạn" → "của {honorific}"
  q = q.replace(/của bạn/g, 'của {honorific}');
  // Replace "bạn" in middle → "{honorific}"
  q = q.replace(/ bạn /g, ' {honorific} ');
  q = q.replace(/ bạn\?/g, ' {honorific}?');
  q = q.replace(/ bạn\./g, ' {honorific}.');

  return q;
}

/**
 * Build script JSON from clinical-mapping data.
 */
function _buildScriptFromMapping(complaintKey, mappingData, cluster) {
  const associated = mappingData.associatedSymptoms || [];
  const redFlags = mappingData.redFlags || [];
  const causes = mappingData.causes || [];
  const followUpQs = mappingData.followUpQuestions || [];

  // Build questions from mapping's followUpQuestions (structured)
  const questions = [];
  let qIndex = 0;

  // Use mapping's own followUpQuestions if available
  for (const fq of followUpQs) {
    qIndex++;
    const qId = `q${qIndex}`;
    const type = fq.multiSelect ? 'multi_choice' : 'single_choice';

    questions.push({
      id: qId,
      text: _addHonorifics(fq.question),
      type,
      options: fq.options || [],
      cluster: cluster.cluster_key,
    });
  }

  // If mapping has no followUpQuestions, build from structure
  if (questions.length === 0) {
    // Q1: severity slider
    questions.push({
      id: 'q1',
      text: `{Honorific} bị ${cluster.display_name} mức nào?`,
      type: 'slider',
      min: 0,
      max: 10,
      cluster: cluster.cluster_key,
    });

    // Q2: associated symptoms (top 6)
    const topAssociated = associated
      .filter(s => s.dangerLevel !== 'danger')
      .slice(0, 5)
      .map(s => s.text);
    if (topAssociated.length > 0) {
      topAssociated.push('không có');
      questions.push({
        id: 'q2',
        text: `{Honorific} có triệu chứng nào đi kèm không?`,
        type: 'multi_choice',
        options: topAssociated,
        cluster: cluster.cluster_key,
      });
    }

    // Q3: onset
    questions.push({
      id: `q${questions.length + 1}`,
      text: `{Honorific} bị từ khi nào?`,
      type: 'single_choice',
      options: ['vừa mới', 'vài giờ trước', 'từ sáng', 'từ hôm qua', 'vài ngày nay'],
      cluster: cluster.cluster_key,
    });

    // Q4: progression
    questions.push({
      id: `q${questions.length + 1}`,
      text: `So với lúc đầu, {honorific} thấy thế nào?`,
      type: 'single_choice',
      options: ['đang đỡ dần', 'vẫn như cũ', 'có vẻ nặng hơn'],
      cluster: cluster.cluster_key,
    });
  }

  // Build scoring rules
  const scoringRules = _buildScoringRules(questions, associated, redFlags);

  // Build conclusion templates
  const conclusionTemplates = _buildConclusionTemplates(cluster);

  return {
    greeting: `{CallName} ơi, {selfRef} hỏi thăm {honorific} về ${cluster.display_name} nhé 💙`,
    questions,
    scoring_rules: scoringRules,
    condition_modifiers: _buildConditionModifiers(questions),
    conclusion_templates: conclusionTemplates,
    followup_questions: _buildFollowUpQuestions(),
    fallback_questions: _buildFallbackQuestions(),
    metadata: {
      source_complaint: complaintKey,
      red_flags_count: redFlags.length,
      associated_count: associated.length,
    },
  };
}

/**
 * Build scoring rules based on question structure.
 */
function _buildScoringRules(questions, associated, redFlags) {
  const rules = [];
  const hasSlider = questions.some(q => q.type === 'slider');
  const hasProgression = questions.some(q =>
    q.options && q.options.includes('có vẻ nặng hơn')
  );

  // Find question IDs
  const sliderId = questions.find(q => q.type === 'slider')?.id;
  const progressionId = questions.find(q =>
    q.options && q.options.includes('có vẻ nặng hơn')
  )?.id;

  // Find danger associated symptoms question
  const dangerSymptoms = associated
    .filter(s => s.dangerLevel === 'danger')
    .map(s => s.text);
  const associatedQId = questions.find(q => q.type === 'multi_choice')?.id;

  // Rule 1: HIGH — slider >= 7 OR progression worse
  if (hasSlider) {
    rules.push({
      conditions: [{ field: sliderId, op: 'gte', value: 7 }],
      combine: 'and',
      severity: 'high',
      follow_up_hours: 1,
      needs_doctor: true,
      needs_family_alert: false,  // Chỉ báo gia đình khi THỰC SỰ nghiêm trọng (emergency/critical)
    });
  }

  // Rule 1b: HIGH — progression worse
  if (hasProgression) {
    rules.push({
      conditions: [{ field: progressionId, op: 'eq', value: 'có vẻ nặng hơn' }],
      combine: 'and',
      severity: 'high',
      follow_up_hours: 1,
      needs_doctor: true,
      needs_family_alert: false,
    });
  }

  // Rule 2: MEDIUM — slider >= 4
  if (hasSlider) {
    rules.push({
      conditions: [{ field: sliderId, op: 'gte', value: 4 }],
      combine: 'and',
      severity: 'medium',
      follow_up_hours: 3,
      needs_doctor: false,
      needs_family_alert: false,
    });
  }

  // Rule 2b: For non-slider scripts, generate rules from question options.
  // Clinical-mapping scripts use single_choice/multi_choice. We need to
  // detect "worst" answers that indicate HIGH severity.
  if (!hasSlider) {
    // Strategy 1: Find severity-type question with "nặng" option
    const severityQ = questions.find(q =>
      q.type === 'single_choice' && q.options &&
      q.options.some(o => o.includes('nặng'))
    );
    if (severityQ) {
      const severeOption = severityQ.options.find(o => o.includes('nặng') && !o.includes('nhẹ'));
      if (severeOption) {
        rules.push({
          conditions: [{ field: severityQ.id, op: 'eq', value: severeOption }],
          combine: 'and',
          severity: 'high',
          follow_up_hours: 1,
          needs_doctor: true,
          needs_family_alert: false,  // Chỉ báo gia đình khi THỰC SỰ nghiêm trọng (emergency/critical)
        });
      }
    }

    // Strategy 1b: Severity-type question identified by text pattern ("mức độ",
    // "ảnh hưởng") whose last option is the worst — even without the word "nặng".
    // Clinical convention: options are ordered mild → severe, so the last option
    // of a severity question is the most severe.
    if (!severityQ) {
      const severityByText = questions.find(q =>
        q.type === 'single_choice' && q.options && q.options.length >= 3 &&
        /mức độ|ảnh hưởng|nghiêm trọng/i.test(q.text)
      );
      if (severityByText) {
        const lastOption = severityByText.options[severityByText.options.length - 1];
        rules.push({
          conditions: [{ field: severityByText.id, op: 'eq', value: lastOption }],
          combine: 'and',
          severity: 'high',
          follow_up_hours: 1,
          needs_doctor: true,
          needs_family_alert: false,
        });
      }
    }

    // Strategy 2: Check for danger associated symptoms in multi_choice
    if (associatedQId && dangerSymptoms.length > 0) {
      for (const ds of dangerSymptoms.slice(0, 3)) {
        rules.push({
          conditions: [{ field: associatedQId, op: 'contains', value: ds }],
          combine: 'and',
          severity: 'high',
          follow_up_hours: 1,
          needs_doctor: true,
          needs_family_alert: false,  // Chỉ báo gia đình khi THỰC SỰ nghiêm trọng (emergency/critical)
        });
      }
    }

    // Strategy 3: For ANY single_choice question, treat the LAST option as
    // most severe (clinical convention: options ordered mild → severe).
    // This catches scripts where no option explicitly contains "nặng".
    for (const q of questions) {
      if (q.type === 'single_choice' && q.options && q.options.length >= 3) {
        const lastOption = q.options[q.options.length - 1];
        // Skip if it's a "không rõ"/"không có" type escape option
        if (lastOption.includes('không') || lastOption.includes('rõ')) continue;
        // Skip if we already have a rule for this question
        if (rules.some(r => r.conditions.some(c => c.field === q.id))) continue;

        rules.push({
          conditions: [{ field: q.id, op: 'eq', value: lastOption }],
          combine: 'and',
          severity: 'medium',
          follow_up_hours: 3,
          needs_doctor: false,
          needs_family_alert: false,
        });
      }
    }

    // Strategy 4: For multi_choice with warning/danger items, any selection = MEDIUM
    for (const q of questions) {
      if (q.type === 'multi_choice' && q.options && q.options.length >= 3) {
        if (rules.some(r => r.conditions.some(c => c.field === q.id))) continue;
        // If user selects anything other than "không có" → at least MEDIUM
        rules.push({
          conditions: [{ field: q.id, op: 'neq', value: 'không có' }],
          combine: 'and',
          severity: 'medium',
          follow_up_hours: 3,
          needs_doctor: false,
          needs_family_alert: false,
        });
      }
    }
  }

  // Rule 3: LOW — default (slider < 4 or no slider)
  rules.push({
    conditions: hasSlider
      ? [{ field: sliderId, op: 'lt', value: 4 }]
      : [],
    combine: 'and',
    severity: 'low',
    follow_up_hours: 6,
    needs_doctor: false,
    needs_family_alert: false,
  });

  return rules;
}

/**
 * Build condition modifiers (medical conditions → severity bump).
 */
function _buildConditionModifiers(questions) {
  const sliderId = questions.find(q => q.type === 'slider')?.id;

  if (sliderId) {
    return [
      {
        user_condition: 'tiểu đường',
        extra_conditions: [{ field: sliderId, op: 'gte', value: 5 }],
        action: 'bump_severity',
        to: 'high',
      },
      {
        user_condition: 'huyết áp',
        extra_conditions: [{ field: sliderId, op: 'gte', value: 5 }],
        action: 'bump_severity',
        to: 'high',
      },
      {
        user_condition: 'tim mạch',
        extra_conditions: [{ field: sliderId, op: 'gte', value: 4 }],
        action: 'bump_severity',
        to: 'high',
      },
    ];
  }

  // No slider — use progression or severity question for modifiers
  const progressionId = questions.find(q =>
    q.options && q.options.includes('có vẻ nặng hơn')
  )?.id;

  if (progressionId) {
    return [
      {
        user_condition: 'tiểu đường',
        extra_conditions: [{ field: progressionId, op: 'eq', value: 'vẫn như cũ' }],
        action: 'bump_severity',
        to: 'high',
      },
      {
        user_condition: 'tim mạch',
        extra_conditions: [],
        action: 'bump_severity',
        to: 'high',
      },
    ];
  }

  // Fallback: always bump for these conditions
  return [
    {
      user_condition: 'tim mạch',
      extra_conditions: [],
      action: 'bump_severity',
      to: 'high',
    },
  ];
}

/**
 * Build conclusion templates — cá nhân hóa theo từng loại triệu chứng.
 */
function _buildConclusionTemplates(cluster) {
  const name = cluster.display_name;
  const key = cluster.cluster_key;

  // Lời khuyên cụ thể theo triệu chứng
  const SPECIFIC_ADVICE = {
    headache: {
      low: 'Nghỉ ngơi, tránh nhìn màn hình lâu, uống đủ nước. Nếu hay đau đầu, nên ghi lại thời điểm và tần suất.',
      medium: 'Uống thuốc giảm đau (paracetamol) nếu có, nằm nghỉ nơi yên tĩnh, tránh ánh sáng mạnh. Nếu không đỡ sau 24h hoặc đau tăng → đi khám.',
      high: '🏥 {Honorific} nên đi khám bác sĩ hôm nay. Đau đầu dữ dội có thể cần kiểm tra huyết áp hoặc chụp chiếu. Trong khi chờ: nằm nghỉ, tránh gắng sức.',
    },
    abdominal_pain: {
      low: 'Ăn nhẹ, tránh đồ cay nóng và dầu mỡ, uống nước ấm. Nếu đau sau ăn thường xuyên, nên ghi lại thực đơn.',
      medium: 'Ăn cháo loãng hoặc thức ăn mềm, tránh rượu bia và thuốc lá. Nếu đau kèm sốt hoặc nôn → đi khám sớm.',
      high: '🏥 {Honorific} nên đi khám bác sĩ hôm nay. Đau bụng nặng có thể cần siêu âm. Trong khi chờ: không ăn, chỉ uống nước, nằm nghiêng trái.',
    },
    dizziness: {
      low: 'Ngồi hoặc nằm nghỉ, tránh đứng dậy nhanh, uống đủ nước. Nếu hay bị khi đứng lên → kiểm tra huyết áp.',
      medium: 'Nằm nghỉ, đầu hơi cao, uống nước từng ngụm nhỏ. Tránh lái xe và leo cầu thang. Nếu kèm ù tai hoặc buồn nôn → đi khám.',
      high: '🏥 {Honorific} nên đi khám bác sĩ hôm nay. Chóng mặt nặng cần đo huyết áp và kiểm tra tai trong. Trong khi chờ: NẰM YÊN, không đi lại một mình.',
    },
    fatigue: {
      low: 'Nghỉ ngơi đầy đủ, ăn uống điều độ, uống đủ 2 lít nước/ngày. Nếu mệt kéo dài hơn 1 tuần, nên xét nghiệm máu.',
      medium: 'Nghỉ ngơi tuyệt đối hôm nay, ăn thức ăn giàu sắt và vitamin. Đo đường huyết nếu có máy. Nếu kèm sụt cân hoặc sốt → đi khám.',
      high: '🏥 {Honorific} nên đi khám bác sĩ hôm nay. Mệt mỏi nặng cần xét nghiệm máu kiểm tra thiếu máu, đường huyết, tuyến giáp. Nằm nghỉ, không gắng sức.',
    },
    chest_pain: {
      low: 'Nghỉ ngơi, hít thở sâu và chậm, tránh gắng sức. Nếu đau khi hít sâu có thể do cơ — chườm ấm nhẹ.',
      medium: 'Nằm nghỉ, nới lỏng quần áo, tránh hoạt động. Đo huyết áp nếu có máy. Nếu đau lan ra tay trái hoặc hàm → gọi cấp cứu.',
      high: '🏥 GỌI CẤP CỨU 115 hoặc đến phòng cấp cứu NGAY. Trong khi chờ: ngồi nghỉ, nới lỏng quần áo, nhai 1 viên aspirin nếu có.',
    },
    dyspnea: {
      low: 'Ngồi thẳng lưng, hít thở chậm và sâu. Mở cửa sổ cho thoáng. Tránh nằm ngay khi khó thở.',
      medium: 'Ngồi nghỉ, không nằm. Tránh gắng sức. Nếu có bình xịt hen → dùng ngay. Nếu không đỡ sau 30 phút → đi khám.',
      high: '🏥 {Honorific} cần đi khám NGAY. Khó thở nặng có thể nguy hiểm. Trong khi chờ: ngồi thẳng, không nằm, nới lỏng quần áo.',
    },
    back_pain: {
      low: 'Chườm ấm vùng đau, tránh ngồi lâu hoặc bê vác nặng. Thay đổi tư thế mỗi 30 phút. Đi bộ nhẹ nếu không quá đau.',
      medium: 'Nghỉ ngơi, chườm ấm 15-20 phút, uống thuốc giảm đau nếu có. Tránh cúi gập người. Nếu đau lan xuống chân → đi khám sớm.',
      high: '🏥 {Honorific} nên đi khám bác sĩ hôm nay. Đau lưng kèm tê chân hoặc yếu chân cần chụp MRI. Nằm nghỉ trên mặt phẳng cứng.',
    },
    joint_pain: {
      low: 'Chườm ấm hoặc lạnh (tùy viêm hay đau cơ), nghỉ ngơi khớp đau, tránh vận động mạnh. Xoa nhẹ dầu nóng nếu thích.',
      medium: 'Nghỉ ngơi khớp đau, chườm đá 15 phút nếu sưng, uống thuốc giảm đau nếu có. Nếu khớp sưng đỏ nóng → đi khám sớm.',
      high: '🏥 {Honorific} nên đi khám bác sĩ hôm nay. Đau khớp nặng cần xét nghiệm viêm và chụp X-quang. Tránh vận động khớp đau.',
    },
    insomnia: {
      low: 'Tránh caffeine sau 2h chiều, tắt màn hình 1h trước ngủ, phòng tối và mát. Thử thư giãn bằng hít thở sâu.',
      medium: 'Giữ giờ ngủ cố định, tránh ngủ trưa quá 30 phút. Tắm nước ấm trước ngủ. Nếu mất ngủ > 2 tuần liên tục → đi khám.',
      high: '🏥 {Honorific} nên đi khám bác sĩ. Mất ngủ kéo dài ảnh hưởng sức khỏe nghiêm trọng, có thể cần thuốc hỗ trợ.',
    },
    fever: {
      low: 'Uống nhiều nước, mặc đồ thoáng, lau mát. Uống paracetamol nếu sốt > 38.5°C. Theo dõi nhiệt độ mỗi 4h.',
      medium: 'Uống paracetamol đúng liều, uống nhiều nước, lau mát cổ và nách. Nếu sốt > 39°C hoặc kéo dài > 3 ngày → đi khám.',
      high: '🏥 {Honorific} cần đi khám NGAY. Sốt cao kéo dài có thể là dấu hiệu nhiễm trùng nặng. Uống hạ sốt, lau mát, uống nhiều nước trong khi chờ.',
    },
    cough: {
      low: 'Uống nước ấm pha mật ong, súc miệng nước muối, tránh khói bụi. Nếu ho khan kéo dài > 1 tuần → đi khám.',
      medium: 'Uống thuốc ho nếu có, uống nước ấm thường xuyên, tránh lạnh. Nếu ho ra đờm vàng/xanh hoặc kèm sốt → đi khám.',
      high: '🏥 {Honorific} nên đi khám bác sĩ hôm nay. Ho nặng kèm khó thở hoặc ho ra máu cần chụp X-quang phổi ngay.',
    },
    nausea: {
      low: 'Ăn nhẹ (bánh mì, cháo), uống nước gừng ấm, tránh mùi nặng. Ăn ít nhưng nhiều bữa.',
      medium: 'Không ăn 1-2h, uống nước từng ngụm nhỏ. Nếu nôn nhiều → uống oresol bù nước. Nếu kèm đau bụng dữ → đi khám.',
      high: '🏥 {Honorific} nên đi khám bác sĩ. Buồn nôn/nôn liên tục có thể gây mất nước nguy hiểm. Uống oresol, không ăn đồ cứng.',
    },
    diarrhea: {
      low: 'Uống nhiều nước và oresol bù điện giải, ăn cháo trắng, tránh sữa và đồ dầu mỡ. Rửa tay thường xuyên.',
      medium: 'Uống oresol đều đặn, ăn cháo muối. Nếu tiêu chảy > 5 lần/ngày hoặc kèm sốt cao → đi khám ngay.',
      high: '🏥 {Honorific} cần đi khám NGAY. Tiêu chảy nặng gây mất nước nguy hiểm, đặc biệt với người có bệnh nền. Uống oresol liên tục.',
    },
    gastric_pain: {
      low: 'Ăn đúng giờ, tránh bỏ bữa. Tránh đồ chua, cay, cà phê. Uống nước ấm sau ăn 30 phút.',
      medium: 'Uống thuốc dạ dày nếu có (antacid), ăn nhẹ đúng giờ, tránh rượu bia tuyệt đối. Nếu đau kèm nôn ra máu → cấp cứu ngay.',
      high: '🏥 {Honorific} nên đi khám bác sĩ hôm nay. Đau dạ dày nặng có thể cần nội soi. Không uống aspirin/ibuprofen, chỉ dùng paracetamol.',
    },
  };

  // Lấy advice cụ thể, fallback về generic nếu không có
  const specific = SPECIFIC_ADVICE[key] || null;

  return {
    low: {
      summary: `{Honorific} bị ${name} nhẹ, không đáng lo.`,
      recommendation: specific?.low || `Nghỉ ngơi, uống đủ nước. Theo dõi trong 24h.`,
      close_message: `{selfRef} sẽ hỏi lại {honorific} tối nay nhé 💙`,
    },
    medium: {
      summary: `{Honorific} bị ${name} mức trung bình, cần theo dõi thêm.`,
      recommendation: specific?.medium || `Nghỉ ngơi, uống thuốc nếu có. Nếu không đỡ sau 24h nên đi khám.`,
      close_message: `{selfRef} sẽ hỏi lại {honorific} sau 3 tiếng nhé.`,
    },
    high: {
      summary: `{Honorific} bị ${name} nặng, cần được bác sĩ đánh giá.`,
      recommendation: specific?.high || `🏥 {Honorific} nên đi khám bác sĩ hôm nay. Trong khi chờ, nghỉ ngơi và uống nhiều nước.`,
      close_message: `{selfRef} sẽ hỏi lại {honorific} sau 1 tiếng. Đi khám sớm nhé.`,
    },
  };
}

/**
 * Build generic script for clusters without clinical-mapping data.
 */
function _buildGenericScript(cluster) {
  return {
    greeting: `{CallName} ơi, {selfRef} hỏi thăm {honorific} nhé 💙`,
    questions: [
      {
        id: 'q1',
        text: `${cluster.display_name} hôm nay {honorific} thấy mức nào?`,
        type: 'slider',
        min: 0,
        max: 10,
        cluster: cluster.cluster_key,
      },
      {
        id: 'q2',
        text: `{Honorific} có triệu chứng gì đi kèm không?`,
        type: 'free_text',
        cluster: cluster.cluster_key,
      },
      {
        id: 'q3',
        text: `So với lúc đầu, {honorific} thấy thế nào?`,
        type: 'single_choice',
        options: ['đang đỡ dần', 'vẫn như cũ', 'có vẻ nặng hơn'],
        cluster: cluster.cluster_key,
      },
    ],
    scoring_rules: [
      {
        conditions: [{ field: 'q1', op: 'gte', value: 7 }],
        combine: 'and',
        severity: 'high',
        follow_up_hours: 1,
        needs_doctor: true,
        needs_family_alert: false,  // Chỉ báo gia đình khi THỰC SỰ nghiêm trọng (emergency/critical)
      },
      {
        conditions: [
          { field: 'q3', op: 'eq', value: 'có vẻ nặng hơn' },
        ],
        combine: 'and',
        severity: 'high',
        follow_up_hours: 1,
        needs_doctor: true,
        needs_family_alert: false,
      },
      {
        conditions: [{ field: 'q1', op: 'gte', value: 4 }],
        combine: 'and',
        severity: 'medium',
        follow_up_hours: 3,
        needs_doctor: false,
        needs_family_alert: false,
      },
      {
        conditions: [{ field: 'q1', op: 'lt', value: 4 }],
        combine: 'and',
        severity: 'low',
        follow_up_hours: 6,
        needs_doctor: false,
        needs_family_alert: false,
      },
    ],
    condition_modifiers: [
      {
        user_condition: 'tiểu đường',
        extra_conditions: [{ field: 'q1', op: 'gte', value: 5 }],
        action: 'bump_severity',
        to: 'high',
      },
    ],
    conclusion_templates: _buildConclusionTemplates(cluster),
    followup_questions: _buildFollowUpQuestions(),
    fallback_questions: _buildFallbackQuestions(),
  };
}

/**
 * Build a full follow-up script (stored separately from initial script).
 */
function _buildFollowUpScript(cluster) {
  return {
    greeting: `{CallName} ơi, {selfRef} hỏi lại {honorific} nhé`,
    questions: _buildFollowUpQuestions(),
    scoring_rules: [
      {
        conditions: [{ field: 'fu1', op: 'eq', value: 'Nặng hơn' }],
        combine: 'and',
        severity: 'high',
        follow_up_hours: 1,
        needs_doctor: true,
        needs_family_alert: false,  // Chỉ báo gia đình khi THỰC SỰ nghiêm trọng (emergency/critical)
      },
      {
        conditions: [{ field: 'fu2', op: 'eq', value: 'Có' }],
        combine: 'and',
        severity: 'medium',
        follow_up_hours: 3,
        needs_doctor: false,
        needs_family_alert: false,
      },
      {
        conditions: [{ field: 'fu1', op: 'eq', value: 'Đỡ hơn' }],
        combine: 'and',
        severity: 'low',
        follow_up_hours: 6,
        needs_doctor: false,
        needs_family_alert: false,
      },
    ],
    condition_modifiers: [],
    conclusion_templates: _buildConclusionTemplates(cluster),
    followup_questions: _buildFollowUpQuestions(),
    fallback_questions: _buildFallbackQuestions(),
  };
}

/**
 * Standard follow-up questions (same for all clusters).
 */
function _buildFollowUpQuestions() {
  return [
    {
      id: 'fu1',
      text: 'So với lúc trước, {honorific} thấy thế nào?',
      type: 'single_choice',
      options: ['Đỡ hơn', 'Vẫn vậy', 'Nặng hơn'],
    },
    {
      id: 'fu2',
      text: 'Có triệu chứng mới không?',
      type: 'single_choice',
      options: ['Không', 'Có'],
    },
  ];
}

/**
 * Standard fallback questions (used when symptom not in script).
 */
function _buildFallbackQuestions() {
  return [
    {
      id: 'fb1',
      text: 'Đau mức nào?',
      type: 'slider',
      min: 0,
      max: 10,
    },
    {
      id: 'fb2',
      text: 'Từ khi nào?',
      type: 'single_choice',
      options: ['Vừa mới', 'Vài giờ trước', 'Từ sáng', 'Từ hôm qua', 'Vài ngày'],
    },
    {
      id: 'fb3',
      text: 'Nặng hơn không?',
      type: 'single_choice',
      options: ['Đang đỡ', 'Vẫn vậy', 'Nặng hơn'],
    },
  ];
}

// ─── Get user's script (API entry point) ────────────────────────────────────

/**
 * Get the cached script for a user.
 * Returns the highest-priority cluster's script.
 *
 * @param {object} pool
 * @param {number} userId
 * @returns {Promise<{ script: object, clusters: object[], greeting: string } | null>}
 */
async function getUserScript(pool, userId) {
  // Get user's active clusters (sorted by priority)
  const { rows: clusters } = await pool.query(
    `SELECT * FROM problem_clusters
     WHERE user_id = $1 AND is_active = TRUE
     ORDER BY priority DESC, count_7d DESC`,
    [userId]
  );

  if (clusters.length === 0) return null;

  // Get profile for greeting (include display_name/full_name from users table)
  const { rows: profileRows } = await pool.query(
    `SELECT uop.*, u.id as uid, u.display_name, u.full_name
     FROM user_onboarding_profiles uop
     JOIN users u ON u.id = uop.user_id
     WHERE uop.user_id = $1`,
    [userId]
  );
  const profile = profileRows[0] || {};

  // Get scripts for all active clusters
  const { rows: scripts } = await pool.query(
    `SELECT * FROM triage_scripts
     WHERE user_id = $1 AND is_active = TRUE AND script_type = 'initial'
     ORDER BY updated_at DESC`,
    [userId]
  );

  // Build cluster → script map
  const scriptMap = {};
  for (const s of scripts) {
    scriptMap[s.cluster_key] = s;
  }

  // Build greeting
  const h = getHonorifics({
    birth_year: profile.birth_year,
    gender: profile.gender,
    full_name: profile.full_name,
    lang: 'vi',
  });
  const CallName = h.callName.charAt(0).toUpperCase() + h.callName.slice(1);
  const greeting = `Chào ${CallName}! Hôm nay ${h.honorific} thế nào?`;

  // Build initial_options
  const initialOptions = [
    { label: 'Tôi ổn', value: 'fine', emoji: '😊' },
    { label: 'Hơi mệt', value: 'tired', emoji: '😐' },
    { label: 'Rất mệt', value: 'very_tired', emoji: '😫' },
  ];

  // Map clusters with their scripts
  const clusterScripts = clusters.map(c => ({
    cluster_key: c.cluster_key,
    display_name: c.display_name,
    priority: c.priority,
    count_7d: c.count_7d,
    trend: c.trend,
    script_id: scriptMap[c.cluster_key]?.id || null,
    has_script: !!scriptMap[c.cluster_key],
  }));

  return {
    greeting,
    initial_options: initialOptions,
    clusters: clusterScripts,
    scripts: scriptMap,
    profile: {
      birth_year: profile.birth_year,
      gender: profile.gender,
      full_name: profile.full_name,
      medical_conditions: profile.medical_conditions || [],
    },
  };
}

/**
 * Get a specific script by cluster key.
 */
async function getScript(pool, userId, clusterKey, scriptType = 'initial') {
  const { rows } = await pool.query(
    `SELECT * FROM triage_scripts
     WHERE user_id = $1 AND cluster_key = $2 AND script_type = $3 AND is_active = TRUE
     ORDER BY version DESC LIMIT 1`,
    [userId, clusterKey, scriptType]
  );
  return rows[0] || null;
}

// ─── Cluster management ────────────────────────────────────────────────────

/**
 * Add a new cluster for a user (e.g. from fallback → R&D cycle).
 */
async function addCluster(pool, userId, clusterKey, displayName, source = 'rnd_cycle') {
  const { rows } = await pool.query(
    `INSERT INTO problem_clusters (user_id, cluster_key, display_name, source)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, cluster_key) DO UPDATE SET
       is_active = TRUE, updated_at = NOW()
     RETURNING *`,
    [userId, clusterKey, displayName, source]
  );

  const cluster = rows[0];

  // Generate script for new cluster
  await generateScriptForCluster(pool, userId, cluster);

  return cluster;
}

/**
 * Update cluster frequency stats (called by R&D cycle or symptom tracker).
 */
async function updateClusterStats(pool, userId, clusterKey, stats) {
  await pool.query(
    `UPDATE problem_clusters SET
       count_7d = COALESCE($3, count_7d),
       count_30d = COALESCE($4, count_30d),
       trend = COALESCE($5, trend),
       last_triggered_at = COALESCE($6, last_triggered_at),
       updated_at = NOW()
     WHERE user_id = $1 AND cluster_key = $2`,
    [userId, clusterKey, stats.count_7d, stats.count_30d, stats.trend, stats.lastTriggered]
  );
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  toClusterKey,
  createClustersFromOnboarding,
  generateScriptForCluster,
  getUserScript,
  getScript,
  addCluster,
  updateClusterStats,
  CLUSTER_KEY_MAP,
};
