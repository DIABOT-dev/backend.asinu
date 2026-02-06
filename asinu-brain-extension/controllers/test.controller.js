/**
 * Public Test Controller for Asinu Brain
 * ONLY FOR TESTING - No authentication required
 */

const { generateMoodQuestion, generateFollowupQuestion, generateSymptomQuestion } = require('../services/questionGenerator.service');

/**
 * Test endpoint - Generate mood question với mock data
 * GET /api/test/question/mood
 */
async function testMoodQuestion(pool, req, res) {
  try {
    // Mock context - CHỈ chỉ số, KHÔNG có chronic_symptoms
    const mockContext = {
      logsSummary: {
        latest_glucose: { value: 180, unit: 'mg/dL' },
        latest_bp: { systolic: 140, diastolic: 90, pulse: 75 }
      },
      profile: {
        age: '65',
        gender: 'Nam',
        medical_conditions: ['Tiểu đường type 2', 'Cao huyết áp']
        // REMOVED: chronic_symptoms để AI focus vào glucose/BP
      },
      riskLevel: 'MEDIUM'
    };

    const question = await generateMoodQuestion(
      pool,
      999, // Test user ID
      'MORNING',
      mockContext
    );

    return res.status(200).json({
      ok: true,
      message: 'AI-generated mood question with mock context',
      question,
      mock_context: mockContext
    });
  } catch (error) {
    console.error('[test] Error generating mood question:', error);
    return res.status(500).json({
      ok: false,
      error: error.message,
      details: 'Check server logs for details'
    });
  }
}

/**
 * Test endpoint - Generate followup question với mock data
 * GET /api/test/question/followup
 */
async function testFollowupQuestion(pool, req, res) {
  try {
    const mockContext = {
      logsSummary: {
        latest_glucose: { value: 220, unit: 'mg/dL' },
        latest_bp: { systolic: 150, diastolic: 95 }
      },
      profile: {
        age: '70',
        gender: 'Nữ',
        medical_conditions: ['Tiểu đường type 2', 'Tim mạch'],
        chronic_symptoms: ['Chóng mặt']
      },
      riskLevel: 'HIGH',
      previousMood: 'TIRED'
    };

    const question = await generateFollowupQuestion(
      pool,
      999,
      'NOON',
      mockContext
    );

    return res.status(200).json({
      ok: true,
      message: 'AI-generated followup question with mock context',
      question,
      mock_context: mockContext
    });
  } catch (error) {
    console.error('[test] Error generating followup question:', error);
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
}

/**
 * Test endpoint - Generate symptom question với mock data
 * GET /api/test/question/symptom
 */
async function testSymptomQuestion(pool, req, res) {
  try {
    const mockContext = {
      logsSummary: {
        latest_glucose: { value: 250, unit: 'mg/dL' },
        latest_bp: { systolic: 180, diastolic: 110 }
      },
      profile: {
        age: '68',
        gender: 'Nam',
        medical_conditions: ['Tiểu đường type 2', 'Cao huyết áp', 'Suy tim'],
        chronic_symptoms: ['Đau ngực', 'Khó thở']
      },
      riskLevel: 'HIGH',
      mood: 'NOT_OK'
    };

    const question = await generateSymptomQuestion(
      pool,
      999,
      mockContext
    );

    return res.status(200).json({
      ok: true,
      message: 'AI-generated symptom question with mock context',
      question,
      mock_context: mockContext
    });
  } catch (error) {
    console.error('[test] Error generating symptom question:', error);
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
}

/**
 * Test endpoint - Generate all types of questions
 * GET /api/test/question/all
 */
async function testAllQuestions(pool, req, res) {
  try {
    const mockContext = {
      logsSummary: {
        latest_glucose: { value: 195, unit: 'mg/dL' },
        latest_bp: { systolic: 145, diastolic: 92 },
        counts: [
          { log_type: 'glucose', count: 7 },
          { log_type: 'bp', count: 4 },
          { log_type: 'weight', count: 2 }
        ]
      },
      profile: {
        age: '66',
        gender: 'Nam',
        medical_conditions: ['Tiểu đường type 2', 'Cao huyết áp'],
        chronic_symptoms: ['Mệt mỏi']
      },
      riskLevel: 'MEDIUM'
    };

    const [moodQ, followupQ, symptomQ] = await Promise.all([
      generateMoodQuestion(pool, 999, 'MORNING', mockContext),
      generateFollowupQuestion(pool, 999, 'NOON', { ...mockContext, previousMood: 'TIRED' }),
      generateSymptomQuestion(pool, 999, { ...mockContext, mood: 'NOT_OK' })
    ]);

    return res.status(200).json({
      ok: true,
      message: 'All AI-generated questions with mock context',
      questions: {
        mood: moodQ,
        followup: followupQ,
        symptom: symptomQ
      },
      mock_context: mockContext
    });
  } catch (error) {
    console.error('[test] Error generating all questions:', error);
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
}

/**
 * Health check for test API
 * GET /api/test/health
 */
async function testHealth(pool, req, res) {
  return res.status(200).json({
    ok: true,
    message: 'Test API is running',
    openai_configured: !!process.env.OPENAI_API_KEY,
    openai_model: process.env.OPENAI_MODEL || 'not set',
    timestamp: new Date().toISOString()
  });
}

module.exports = {
  testMoodQuestion,
  testFollowupQuestion,
  testSymptomQuestion,
  testAllQuestions,
  testHealth
};
