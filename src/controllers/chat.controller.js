const { chatRequestSchema } = require('../validation/validation.schemas');
const { getChatReply } = require('../services/chat.provider.service');

const FALLBACK_CONTEXT =
  'Người dùng chưa có hồ sơ onboarding chi tiết. Hãy trả lời thấu cảm, ngắn gọn, không giả định dữ liệu cá nhân.';

const collectIssueItems = (items) => {
  if (!Array.isArray(items) || items.length === 0) return [];
  return items
    .map((item) => {
      if (typeof item === 'string') return item.trim();
      if (!item || typeof item !== 'object') return '';
      return (item.other_text || item.label || item.key || '').trim();
    })
    .filter(Boolean);
};

const formatIssueList = (items) => collectIssueItems(items).join(', ');

const buildOnboardingContext = (profile) => {
  if (!profile) return FALLBACK_CONTEXT;
  const medical = formatIssueList(profile.medical_conditions);
  const symptoms = formatIssueList(profile.chronic_symptoms);
  const joints = formatIssueList(profile.joint_issues);
  const notes = [];
  notes.push(`Giới tính: ${profile.gender}. Nhóm tuổi: ${profile.age}.`);
  notes.push(`Mục tiêu: ${profile.goal}. Thể trạng: ${profile.body_type}.`);
  if (medical) notes.push(`Bệnh lý: ${medical}.`);
  if (symptoms) notes.push(`Triệu chứng: ${symptoms}.`);
  if (joints) notes.push(`Vấn đề khớp: ${joints}.`);
  notes.push(
    `Thói quen: linh hoạt ${profile.flexibility}, leo thang ${profile.stairs_performance}, ` +
      `tập luyện ${profile.exercise_freq}, đi bộ ${profile.walking_habit}, ` +
      `nước ${profile.water_intake}, ngủ ${profile.sleep_duration}.`
  );
  notes.push('Hãy trả lời thấu cảm, dễ hiểu, có bước hành động cụ thể; nhắc lại mục tiêu hoặc triệu chứng chính ít nhất một lần.');
  return notes.join(' ');
};

const buildMentionHint = (profile) => {
  if (!profile) return '';
  const symptoms = collectIssueItems(profile.chronic_symptoms);
  const joints = collectIssueItems(profile.joint_issues);
  const primarySymptom = symptoms[0] || joints[0] || '';
  if (profile.goal && primarySymptom) {
    return `Mục tiêu của bạn là ${profile.goal}, triệu chứng chính là ${primarySymptom}.`;
  }
  if (profile.goal) {
    return `Mục tiêu của bạn là ${profile.goal}.`;
  }
  if (primarySymptom) {
    return `Triệu chứng chính là ${primarySymptom}.`;
  }
  return '';
};

const replyMentionsProfile = (reply, profile) => {
  if (!profile || !reply) return false;
  const keywords = [
    profile.goal,
    ...collectIssueItems(profile.chronic_symptoms),
    ...collectIssueItems(profile.joint_issues),
  ].filter(Boolean);
  const normalized = reply.toLowerCase();
  return keywords.some((item) => normalized.includes(String(item).toLowerCase()));
};

async function getOnboardingProfile(pool, userId) {
  const result = await pool.query(
    'SELECT * FROM user_onboarding_profiles WHERE user_id = $1',
    [userId]
  );
  return result.rows[0] || null;
}

async function postChat(pool, req, res) {
  const parsed = chatRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: 'Invalid payload', details: parsed.error.issues });
  }

  const { message, client_ts, context } = parsed.data;

  try {
    const userId = req.user.id;
    const now = new Date();

    await pool.query(
      `INSERT INTO chat_histories (user_id, message, sender, created_at)
       VALUES ($1, $2, 'user', $3)`,
      [userId, message, now]
    );

    const provider = String(process.env.AI_PROVIDER || '').toLowerCase();
    let finalMessage = message;
    let onboardingProfile = null;
    if (provider === 'diabrain') {
      let contextText = FALLBACK_CONTEXT;
      try {
        onboardingProfile = await getOnboardingProfile(pool, userId);
        contextText = buildOnboardingContext(onboardingProfile);
      } catch (err) {
        console.warn('onboarding context fetch failed:', err?.message || err);
      }
      finalMessage = `### SYSTEM_CONTEXT\n${contextText}\n### USER\n${message}`;
    }

    const providerContext = { ...(context || {}), user_id: userId };
    const replyResult = await getChatReply(finalMessage, providerContext);
    let reply = replyResult.reply || '';
    const replyProvider = replyResult.provider || 'mock';
    if (replyProvider === 'diabrain' && onboardingProfile) {
      if (!replyMentionsProfile(reply, onboardingProfile)) {
        const hint = buildMentionHint(onboardingProfile);
        if (hint) {
          reply = `${reply} ${hint}`;
        }
      }
    }

    const assistantResult = await pool.query(
      `INSERT INTO chat_histories (user_id, message, sender, created_at)
       VALUES ($1, $2, 'assistant', $3)
       RETURNING id, created_at`,
      [userId, reply, now]
    );

    const row = assistantResult.rows[0];
    return res.status(200).json({
      ok: true,
      reply,
      chat_id: row?.id,
      provider: replyProvider,
      created_at: row?.created_at ? new Date(row.created_at).toISOString() : now.toISOString(),
      client_ts,
    });
  } catch (err) {
    console.error('chat failed:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}

module.exports = { postChat };
