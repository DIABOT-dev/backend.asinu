const { documentedSoap } = require('../src/services/integrations/doctor-documentation');
const { missingPlannedFollowup } = require('../src/services/integrations/doctor-documentation');
const {
  unsupportedDocumentedClaims,
} = require('../src/services/integrations/doctor-documented-facts');
const { buildRetrievalContextQuery } = require('../src/services/integrations/doctor-dialogue');

test('an unexamined abdominal-pain consultation has no invented objective finding, diagnosis or plan', () => {
  const soap = documentedSoap(
    { conversation: [{ role: 'doctor', message_type: 'question', message: 'Có sốt không?' }] },
    'Bệnh nhân kể đau quanh rốn ba ngày.'
  );
  expect(soap).toEqual({
    subjective: 'Bệnh nhân kể đau quanh rốn ba ngày.',
    objective: '',
    assessment: '',
    plan: '',
  });
});

test('an actual sent draft is attributed and historical diagnoses never become the current assessment', () => {
  const text = 'Em ghi lại giờ đau và đi khám nếu đau tăng.';
  const soap = documentedSoap(
    {
      medical_records: [{ diagnosis: 'Một chẩn đoán từ ca cũ', treatment: 'Kế hoạch cũ' }],
      conversation: [
        { role: 'patient', message_type: 'reply', message: 'Cho tôi kế hoạch khác.' },
        { role: 'doctor', message_type: 'consultation', message: text, id: 'sent-1' },
        {
          role: 'doctor',
          sender_ref: 'doctor-sla-worker',
          message_type: 'follow_up',
          message: 'SLA reminder',
        },
      ],
    },
    'Bệnh nhân kể đau bụng.'
  );
  expect(soap.assessment).toBe('');
  expect(soap.plan).toContain(`[sent-1] ${text}`);
  expect(soap.plan).not.toMatch(/Kế hoạch cũ|SLA reminder|kế hoạch khác/);
});

test('the completed current assessment and all plan components are preserved exactly', () => {
  const summary = {
    assessment: 'Chưa xác định nguyên nhân qua trao đổi từ xa.',
    next_steps: 'Ghi nhật ký triệu chứng.',
    warning_signs: 'Đau tăng: đi khám ngay.',
    follow_up_recommendation: 'Trao đổi lại sau 48 giờ.',
  };
  const soap = documentedSoap({ consultation_summary: summary }, 'Đau bụng.');
  expect(soap.assessment).toBe(summary.assessment);
  expect(soap.plan).toBe(
    [summary.next_steps, summary.warning_signs, summary.follow_up_recommendation].join('\n')
  );
});

test('app measurements retain their date and provenance and are not presented as an examination', () => {
  const soap = documentedSoap(
    {
      blood_pressure: [
        { systolic: 145, diastolic: 92, occurred_at: '2026-11-16T01:00:00Z' },
        { systolic: null, diastolic: null },
      ],
    },
    ''
  );
  expect(soap.objective).toContain('chưa được xác minh khi khám');
  expect(soap.objective).toContain('2026-11-16T01:00:00Z: 145/92 mmHg');
  expect(soap.objective).not.toContain('null');
});

test.each(['patient_summary', 'soap_note', 'suggested_questions'])(
  'documentation/questions do not use reference literature as patient evidence: %s',
  (touchpoint) => {
    expect(
      buildRetrievalContextQuery(
        { latest_patient_message: { message: 'Đau bụng ba ngày.' } },
        'Đau bụng',
        touchpoint
      )
    ).toBe('');
  }
);

test('a few denied symptoms cannot become an exclusion of all acute pathology', () => {
  const context = { conversation: [{ role: 'patient', message: 'Không sốt, chưa nôn.' }] };
  expect(
    unsupportedDocumentedClaims(context, {
      clinical_summary: 'Không có dấu hiệu cấp tính nào khác.',
    })
  ).not.toHaveLength(0);
  expect(
    unsupportedDocumentedClaims(context, {
      clinical_summary: 'Bệnh nhân cho biết không sốt, chưa nôn.',
    })
  ).toHaveLength(0);
});

test('routine follow-up preserves the documented interval, including equivalent day/hour wording', () => {
  expect(
    missingPlannedFollowup(
      'Trao đổi lại sau 48 giờ nếu chưa cải thiện.',
      'Mang nhật ký khi đi khám.'
    )
  ).toBe(true);
  expect(
    missingPlannedFollowup(
      'Trao đổi lại sau 48 giờ nếu chưa cải thiện.',
      'Nếu chưa cải thiện sau 2 ngày, em nhắn lại.'
    )
  ).toBe(false);
});

test('a long documented plan is referenced in full instead of silently cutting off its warning signs', () => {
  const summary = {
    assessment: 'Đã ghi nhận',
    next_steps: 'Nội dung dài '.repeat(420),
    warning_signs: 'Dấu hiệu cảnh báo ở cuối',
    follow_up_recommendation: 'Trao đổi lại sau 48 giờ',
  };
  const soap = documentedSoap({ consultation_summary: summary }, '');
  expect(soap.plan).toContain('Xem đầy đủ kế hoạch');
  expect(soap.plan).toContain('dấu hiệu cảnh báo');
  expect(soap.plan.length).toBeLessThan(5000);
});
