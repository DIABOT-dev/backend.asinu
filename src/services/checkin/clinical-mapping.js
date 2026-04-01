/**
 * Clinical Symptom Mapping — Asinu Health Companion
 *
 * Comprehensive chief-complaint → associated-symptoms mapping for Vietnamese triage.
 * Used by checkin.ai.service.js to generate clinically accurate follow-up questions.
 *
 * Clinical basis:
 *   - Manchester Triage System (MTS) discriminators
 *   - Canadian Triage and Acuity Scale (CTAS) complaint-specific modules
 *   - WHO IMAI (Integrated Management of Adolescent and Adult Illness)
 *   - OPQRST clinical interview framework
 *   - Vietnamese endemic disease context (dengue, TB, parasitic infections)
 *
 * Structure per chief complaint:
 *   associatedSymptoms — TYPE 3 follow-up: narrow differential diagnosis
 *   redFlags           — TYPE 6: immediate escalation triggers → hasRedFlag=true, severity=high, needsDoctor=true
 *   causes             — TYPE 7: common etiologies to ask about
 *   followUpQuestions   — structured Q&A for the triage engine
 */

const symptomMap = {

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. ĐAU ĐẦU (Headache)
  // ═══════════════════════════════════════════════════════════════════════════
  'đau đầu': {
    associatedSymptoms: [
      { text: 'buồn nôn hoặc nôn', dangerLevel: 'warning' },
      { text: 'sốt', dangerLevel: 'warning' },
      { text: 'cứng cổ, khó cúi đầu', dangerLevel: 'danger' },
      { text: 'mờ mắt hoặc nhìn đôi', dangerLevel: 'danger' },
      { text: 'chóng mặt', dangerLevel: 'normal' },
      { text: 'nhạy cảm với ánh sáng', dangerLevel: 'warning' },
      { text: 'nhạy cảm với tiếng ồn', dangerLevel: 'normal' },
      { text: 'chảy nước mũi hoặc nghẹt mũi', dangerLevel: 'normal' },
      { text: 'đau vùng mắt', dangerLevel: 'normal' },
      { text: 'tê hoặc yếu nửa người', dangerLevel: 'danger' },
      { text: 'nói ngọng, khó nói', dangerLevel: 'danger' },
      { text: 'co giật', dangerLevel: 'danger' },
      { text: 'phát ban, nổi chấm đỏ trên da', dangerLevel: 'danger' },
    ],

    redFlags: [
      'đau đầu dữ dội đột ngột (như sét đánh)',
      'yếu hoặc tê nửa người',
      'nói ngọng, khó nói, không hiểu lời',
      'co giật',
      'cứng cổ kèm sốt cao',
      'mờ mắt đột ngột hoặc mất thị lực',
      'lú lẫn, mất phương hướng',
      'đau đầu sau chấn thương đầu',
      'đau đầu ngày càng nặng hơn trong vài ngày',
      'sốt cao trên 39°C kèm đau đầu dữ dội',
      'nôn ói nhiều lần không cầm được',
    ],

    causes: [
      'ngủ ít hoặc mất ngủ',
      'căng thẳng, lo âu',
      'quên uống thuốc huyết áp',
      'uống ít nước, mất nước',
      'bỏ bữa hoặc ăn không đủ',
      'thay đổi thời tiết',
      'nhìn màn hình lâu',
      'uống rượu bia',
      'tiền sử đau nửa đầu (migraine)',
      'nghiến răng khi ngủ',
    ],

    followUpQuestions: [
      {
        question: 'Đau đầu ở vị trí nào?',
        options: ['một bên đầu', 'cả hai bên', 'sau gáy', 'vùng trán', 'quanh mắt', 'toàn bộ đầu'],
        multiSelect: false,
      },
      {
        question: 'Kiểu đau như thế nào?',
        options: ['nhức âm ỉ', 'đau nhói từng cơn', 'đau như bóp chặt', 'đau giật theo nhịp tim'],
        multiSelect: false,
      },
      {
        question: 'Bạn có thêm triệu chứng nào đi kèm?',
        options: ['buồn nôn', 'chóng mặt', 'sợ ánh sáng', 'mờ mắt', 'cứng cổ', 'sốt', 'không có'],
        multiSelect: true,
      },
      {
        question: 'Mức độ đau đầu hiện tại?',
        options: ['nhẹ, vẫn sinh hoạt được', 'trung bình, khó tập trung', 'nặng, phải nằm nghỉ'],
        multiSelect: false,
      },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. ĐAU BỤNG (Abdominal Pain)
  // ═══════════════════════════════════════════════════════════════════════════
  'đau bụng': {
    associatedSymptoms: [
      { text: 'buồn nôn hoặc nôn', dangerLevel: 'normal' },
      { text: 'tiêu chảy', dangerLevel: 'normal' },
      { text: 'táo bón', dangerLevel: 'normal' },
      { text: 'sốt', dangerLevel: 'warning' },
      { text: 'chướng bụng, đầy hơi', dangerLevel: 'normal' },
      { text: 'đi ngoài ra máu', dangerLevel: 'danger' },
      { text: 'nôn ra máu', dangerLevel: 'danger' },
      { text: 'không trung tiện hoặc đi ngoài được', dangerLevel: 'danger' },
      { text: 'vàng da, vàng mắt', dangerLevel: 'danger' },
      { text: 'đau lan ra sau lưng', dangerLevel: 'warning' },
      { text: 'tiểu buốt, tiểu rát', dangerLevel: 'warning' },
      { text: 'ăn không tiêu', dangerLevel: 'normal' },
      { text: 'sụt cân không rõ nguyên nhân', dangerLevel: 'warning' },
    ],

    redFlags: [
      'đau bụng dữ dội, bụng cứng như gỗ',
      'nôn ra máu hoặc chất nâu đen',
      'đi ngoài phân đen hoặc có máu',
      'bụng chướng to kèm không trung tiện',
      'sốt cao trên 39°C kèm đau bụng',
      'vàng da, vàng mắt',
      'đau bụng sau chấn thương',
      'ngất hoặc choáng kèm đau bụng',
      'đau bụng dưới dữ dội ở phụ nữ (nghi ngoài tử cung)',
      'đau bụng vùng thượng vị lan ra sau lưng (nghi tụy)',
    ],

    causes: [
      'ăn đồ lạ hoặc không hợp vệ sinh',
      'ăn quá no hoặc bỏ bữa',
      'căng thẳng, lo âu',
      'uống rượu bia',
      'dùng thuốc giảm đau (aspirin, ibuprofen)',
      'táo bón lâu ngày',
      'kinh nguyệt (phụ nữ)',
      'tiền sử bệnh dạ dày',
      'ăn thức ăn để qua đêm',
      'uống sữa (không dung nạp lactose)',
    ],

    followUpQuestions: [
      {
        question: 'Đau bụng ở vị trí nào?',
        options: ['vùng thượng vị (trên rốn)', 'quanh rốn', 'bụng dưới bên phải', 'bụng dưới bên trái', 'bụng dưới giữa', 'lan khắp bụng'],
        multiSelect: false,
      },
      {
        question: 'Kiểu đau như thế nào?',
        options: ['đau âm ỉ liên tục', 'đau quặn từng cơn', 'đau rát, nóng bỏng', 'đau tức, căng chướng'],
        multiSelect: false,
      },
      {
        question: 'Đau có liên quan đến ăn uống không?',
        options: ['đau nhiều khi đói', 'đau sau khi ăn', 'không liên quan đến ăn uống', 'không rõ'],
        multiSelect: false,
      },
      {
        question: 'Bạn có thêm triệu chứng nào?',
        options: ['buồn nôn', 'tiêu chảy', 'táo bón', 'sốt', 'chướng bụng', 'tiểu buốt', 'không có'],
        multiSelect: true,
      },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. CHÓNG MẶT (Dizziness / Vertigo)
  // ═══════════════════════════════════════════════════════════════════════════
  'chóng mặt': {
    associatedSymptoms: [
      { text: 'buồn nôn hoặc nôn', dangerLevel: 'normal' },
      { text: 'ù tai', dangerLevel: 'warning' },
      { text: 'giảm thính lực', dangerLevel: 'warning' },
      { text: 'hoa mắt, tối sầm', dangerLevel: 'warning' },
      { text: 'mất thăng bằng, loạng choạng', dangerLevel: 'warning' },
      { text: 'ngất hoặc suýt ngất', dangerLevel: 'danger' },
      { text: 'nhìn đôi', dangerLevel: 'danger' },
      { text: 'yếu hoặc tê một bên cơ thể', dangerLevel: 'danger' },
      { text: 'nói ngọng', dangerLevel: 'danger' },
      { text: 'đau đầu dữ dội', dangerLevel: 'danger' },
      { text: 'tim đập nhanh hoặc không đều', dangerLevel: 'warning' },
      { text: 'vã mồ hôi', dangerLevel: 'warning' },
      { text: 'run tay', dangerLevel: 'normal' },
    ],

    redFlags: [
      'ngất xỉu hoặc mất ý thức',
      'yếu hoặc tê nửa người',
      'nói ngọng, khó nói',
      'nhìn đôi hoặc mờ mắt đột ngột',
      'đau đầu dữ dội kèm chóng mặt',
      'đau ngực kèm chóng mặt',
      'khó thở kèm chóng mặt',
      'tim đập rất nhanh hoặc không đều',
      'chóng mặt sau chấn thương đầu',
      'co giật',
    ],

    causes: [
      'đứng dậy quá nhanh (hạ huyết áp tư thế)',
      'uống ít nước, mất nước',
      'bỏ bữa, hạ đường huyết',
      'ngủ ít, mệt mỏi',
      'thuốc huyết áp hoặc thuốc mới',
      'nắng nóng, ở ngoài trời lâu',
      'tiền sử rối loạn tiền đình',
      'thiếu máu',
      'căng thẳng, lo âu',
      'uống rượu bia',
    ],

    followUpQuestions: [
      {
        question: 'Chóng mặt kiểu nào?',
        options: ['quay cuồng (phòng quay)', 'lâng lâng, lơ lửng', 'tối sầm mắt', 'mất thăng bằng, loạng choạng'],
        multiSelect: false,
      },
      {
        question: 'Chóng mặt xuất hiện khi nào?',
        options: ['khi đứng dậy', 'khi xoay đầu', 'liên tục không ngừng', 'khi nằm nghiêng', 'bất kỳ lúc nào'],
        multiSelect: true,
      },
      {
        question: 'Bạn có thêm triệu chứng nào?',
        options: ['buồn nôn', 'ù tai', 'hoa mắt', 'tim đập nhanh', 'vã mồ hôi', 'đau đầu', 'không có'],
        multiSelect: true,
      },
      {
        question: 'Bạn có đang dùng thuốc huyết áp hoặc thuốc mới không?',
        options: ['có, thuốc huyết áp', 'có, thuốc mới kê gần đây', 'không dùng thuốc gì', 'không rõ'],
        multiSelect: false,
      },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. MỆT MỎI (Fatigue)
  // ═══════════════════════════════════════════════════════════════════════════
  'mệt mỏi': {
    associatedSymptoms: [
      { text: 'khó ngủ hoặc mất ngủ', dangerLevel: 'normal' },
      { text: 'ăn không ngon', dangerLevel: 'normal' },
      { text: 'sụt cân không rõ nguyên nhân', dangerLevel: 'warning' },
      { text: 'sốt nhẹ kéo dài', dangerLevel: 'warning' },
      { text: 'khó thở khi gắng sức', dangerLevel: 'warning' },
      { text: 'da xanh xao, nhợt nhạt', dangerLevel: 'warning' },
      { text: 'đau nhức cơ thể', dangerLevel: 'normal' },
      { text: 'khát nước nhiều, tiểu nhiều', dangerLevel: 'warning' },
      { text: 'buồn bã, không muốn làm gì', dangerLevel: 'warning' },
      { text: 'chóng mặt khi đứng dậy', dangerLevel: 'normal' },
      { text: 'hạch to ở cổ, nách, bẹn', dangerLevel: 'danger' },
      { text: 'ho kéo dài trên 2 tuần', dangerLevel: 'danger' },
      { text: 'sốt về chiều, đổ mồ hôi đêm', dangerLevel: 'danger' },
    ],

    redFlags: [
      'mệt mỏi nặng đến mức không dậy nổi',
      'sụt cân nhanh không rõ nguyên nhân (trên 5kg/tháng)',
      'sốt kéo dài trên 2 tuần',
      'ho kéo dài kèm sốt nhẹ (nghi lao)',
      'đổ mồ hôi đêm nhiều',
      'khó thở ngay cả khi nghỉ ngơi',
      'da xanh xao kèm chóng mặt nhiều',
      'hạch to không đau',
      'vàng da, vàng mắt',
      'xuất huyết bất thường (chảy máu nướu, bầm tím)',
    ],

    causes: [
      'ngủ ít hoặc ngủ không sâu',
      'ăn uống không đủ chất',
      'căng thẳng, lo âu kéo dài',
      'ít vận động',
      'bệnh mạn tính (tiểu đường, huyết áp)',
      'thiếu máu, thiếu sắt',
      'thuốc đang dùng (thuốc ngủ, thuốc HA)',
      'sau ốm hoặc sau phẫu thuật',
      'trầm cảm hoặc stress kéo dài',
      'thay đổi thời tiết',
    ],

    followUpQuestions: [
      {
        question: 'Mệt mỏi kéo dài bao lâu rồi?',
        options: ['hôm nay mới thấy', 'vài ngày nay', '1-2 tuần', 'trên 2 tuần'],
        multiSelect: false,
      },
      {
        question: 'Mệt mỏi ảnh hưởng thế nào?',
        options: ['vẫn sinh hoạt bình thường', 'phải nghỉ ngơi nhiều hơn', 'khó làm việc nhà', 'hầu như nằm cả ngày'],
        multiSelect: false,
      },
      {
        question: 'Bạn có thêm triệu chứng nào?',
        options: ['mất ngủ', 'ăn kém', 'sốt nhẹ', 'sụt cân', 'buồn bã', 'khó thở', 'không có'],
        multiSelect: true,
      },
      {
        question: 'Giấc ngủ của bạn gần đây thế nào?',
        options: ['ngủ đủ 6-8 tiếng', 'ngủ ít hơn 5 tiếng', 'ngủ chập chờn', 'thức dậy nhiều lần trong đêm'],
        multiSelect: false,
      },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. ĐAU NGỰC / TỨC NGỰC (Chest Pain)
  // ═══════════════════════════════════════════════════════════════════════════
  'đau ngực': {
    associatedSymptoms: [
      { text: 'khó thở', dangerLevel: 'danger' },
      { text: 'đau lan ra cánh tay trái hoặc hàm', dangerLevel: 'danger' },
      { text: 'vã mồ hôi lạnh', dangerLevel: 'danger' },
      { text: 'tim đập nhanh hoặc không đều', dangerLevel: 'danger' },
      { text: 'buồn nôn hoặc nôn', dangerLevel: 'warning' },
      { text: 'chóng mặt hoặc choáng', dangerLevel: 'warning' },
      { text: 'ho', dangerLevel: 'normal' },
      { text: 'sốt', dangerLevel: 'warning' },
      { text: 'đau tăng khi hít sâu', dangerLevel: 'warning' },
      { text: 'đau tăng khi ấn vào ngực', dangerLevel: 'normal' },
      { text: 'ợ nóng, ợ chua', dangerLevel: 'normal' },
      { text: 'lo lắng, sợ hãi', dangerLevel: 'normal' },
    ],

    redFlags: [
      'đau thắt ngực lan ra cánh tay trái, vai, hàm, lưng',
      'đau ngực kèm khó thở dữ dội',
      'đau ngực kèm vã mồ hôi lạnh',
      'đau ngực kèm choáng váng, ngất',
      'tim đập nhanh bất thường hoặc rối loạn nhịp',
      'đau ngực đột ngột dữ dội',
      'đau ngực kèm ho ra máu',
      'đau ngực sau chấn thương',
      'tiền sử bệnh tim mạch kèm đau ngực mới',
      'tím môi, tím đầu ngón tay',
    ],

    causes: [
      'căng thẳng, lo âu (cơn hoảng sợ)',
      'trào ngược dạ dày (GERD)',
      'căng cơ ngực (mang vác nặng)',
      'tiền sử bệnh tim mạch',
      'huyết áp cao không kiểm soát',
      'hút thuốc lá',
      'ít vận động, đột ngột gắng sức',
      'sau ăn no',
      'thay đổi thời tiết',
      'viêm sụn sườn',
    ],

    followUpQuestions: [
      {
        question: 'Đau ngực kiểu nào?',
        options: ['đau thắt, bóp chặt', 'đau nhói như kim đâm', 'đau tức nặng', 'đau rát, nóng bỏng', 'đau âm ỉ'],
        multiSelect: false,
      },
      {
        question: 'Đau ngực có lan ra chỗ khác không?',
        options: ['lan ra cánh tay trái', 'lan lên hàm hoặc cổ', 'lan ra sau lưng', 'chỉ đau tại chỗ', 'không rõ'],
        multiSelect: true,
      },
      {
        question: 'Đau ngực xuất hiện khi nào?',
        options: ['khi nghỉ ngơi', 'khi gắng sức', 'sau khi ăn', 'khi nằm', 'bất kỳ lúc nào'],
        multiSelect: true,
      },
      {
        question: 'Bạn có thêm triệu chứng nào?',
        options: ['khó thở', 'vã mồ hôi', 'tim đập nhanh', 'chóng mặt', 'buồn nôn', 'không có'],
        multiSelect: true,
      },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 5b. TỨC NGỰC (alias — maps to same logic as đau ngực)
  // ═══════════════════════════════════════════════════════════════════════════
  'tức ngực': null, // resolved at runtime → uses 'đau ngực'

  // ═══════════════════════════════════════════════════════════════════════════
  // 6. KHÓ THỞ (Shortness of Breath)
  // ═══════════════════════════════════════════════════════════════════════════
  'khó thở': {
    associatedSymptoms: [
      { text: 'đau ngực hoặc tức ngực', dangerLevel: 'danger' },
      { text: 'ho', dangerLevel: 'normal' },
      { text: 'ho ra đờm có máu', dangerLevel: 'danger' },
      { text: 'thở khò khè, tiếng rít', dangerLevel: 'warning' },
      { text: 'sốt', dangerLevel: 'warning' },
      { text: 'phù chân', dangerLevel: 'warning' },
      { text: 'tím môi hoặc đầu ngón tay', dangerLevel: 'danger' },
      { text: 'tim đập nhanh', dangerLevel: 'warning' },
      { text: 'khó nói hết câu', dangerLevel: 'danger' },
      { text: 'lo lắng, bồn chồn', dangerLevel: 'normal' },
      { text: 'mệt mỏi', dangerLevel: 'normal' },
      { text: 'nằm không được, phải ngồi để thở', dangerLevel: 'danger' },
    ],

    redFlags: [
      'khó thở dữ dội đột ngột',
      'tím môi, tím đầu ngón tay',
      'không nói được hết câu vì khó thở',
      'phải ngồi dậy để thở, không nằm được',
      'đau ngực kèm khó thở',
      'ho ra máu',
      'sưng phù một bên chân kèm khó thở (nghi thuyên tắc phổi)',
      'sốt cao kèm khó thở nặng',
      'lú lẫn, lơ mơ kèm khó thở',
      'tiền sử hen suyễn đang lên cơn nặng',
      'thở rất nhanh (trên 30 lần/phút)',
    ],

    causes: [
      'hen suyễn hoặc COPD',
      'nhiễm trùng phổi (viêm phổi)',
      'suy tim',
      'lo lắng, cơn hoảng sợ',
      'thiếu máu',
      'gắng sức quá mức',
      'dị ứng, phản ứng phản vệ',
      'trào ngược dạ dày',
      'ô nhiễm không khí, bụi',
      'béo phì',
    ],

    followUpQuestions: [
      {
        question: 'Khó thở xuất hiện khi nào?',
        options: ['khi gắng sức (đi bộ, leo cầu thang)', 'khi nghỉ ngơi', 'khi nằm', 'về đêm', 'liên tục'],
        multiSelect: true,
      },
      {
        question: 'Mức độ khó thở?',
        options: ['hơi khó thở khi hoạt động', 'khó thở khi làm việc nhẹ', 'khó thở ngay khi nghỉ', 'không nói được hết câu'],
        multiSelect: false,
      },
      {
        question: 'Bạn có thêm triệu chứng nào?',
        options: ['ho', 'đau ngực', 'sốt', 'phù chân', 'thở khò khè', 'tim đập nhanh', 'không có'],
        multiSelect: true,
      },
      {
        question: 'Bạn có tiền sử bệnh phổi hoặc tim không?',
        options: ['hen suyễn', 'COPD (phổi tắc nghẽn)', 'suy tim', 'không có bệnh nền', 'không rõ'],
        multiSelect: true,
      },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 7. ĐAU VAI / LƯNG / KHỚP (Musculoskeletal Pain)
  // ═══════════════════════════════════════════════════════════════════════════
  'đau vai': {
    associatedSymptoms: [
      { text: 'cứng khớp buổi sáng', dangerLevel: 'normal' },
      { text: 'sưng đỏ tại khớp', dangerLevel: 'warning' },
      { text: 'nóng rát tại khớp', dangerLevel: 'warning' },
      { text: 'hạn chế vận động', dangerLevel: 'normal' },
      { text: 'tê tay hoặc chân', dangerLevel: 'warning' },
      { text: 'yếu cơ', dangerLevel: 'warning' },
      { text: 'sốt kèm đau khớp', dangerLevel: 'danger' },
      { text: 'đau lan xuống chân (đau thần kinh tọa)', dangerLevel: 'warning' },
      { text: 'không kiểm soát tiểu tiện', dangerLevel: 'danger' },
      { text: 'đau nhiều về đêm, không đỡ khi nghỉ', dangerLevel: 'warning' },
    ],

    redFlags: [
      'đau lưng kèm mất kiểm soát tiểu tiện',
      'yếu hoặc tê cả hai chân (hội chứng đuôi ngựa)',
      'sốt cao kèm sưng đỏ khớp (nghi nhiễm trùng khớp)',
      'đau khớp sau chấn thương nặng',
      'sưng đỏ nóng một khớp đột ngột',
      'đau lưng kèm sụt cân không rõ nguyên nhân',
      'đau xương về đêm ngày càng nặng',
      'tiền sử ung thư kèm đau xương mới',
      'không cử động được chi',
      'biến dạng chi sau chấn thương',
    ],

    causes: [
      'mang vác nặng, sai tư thế',
      'ngồi lâu một tư thế',
      'thoái hóa khớp (tuổi tác)',
      'viêm khớp',
      'chấn thương khi lao động',
      'tập thể dục sai cách',
      'thay đổi thời tiết',
      'gout (thống phong)',
      'loãng xương',
      'stress kéo dài',
    ],

    followUpQuestions: [
      {
        question: 'Đau ở vị trí nào?',
        options: ['vai', 'cổ', 'lưng trên', 'thắt lưng', 'khớp gối', 'khớp tay', 'hông', 'nhiều khớp'],
        multiSelect: true,
      },
      {
        question: 'Đau tăng khi nào?',
        options: ['khi vận động', 'khi nghỉ ngơi', 'buổi sáng khi mới dậy', 'về đêm', 'khi thay đổi thời tiết'],
        multiSelect: true,
      },
      {
        question: 'Khớp có sưng hoặc đỏ không?',
        options: ['có sưng', 'có đỏ nóng', 'cứng khớp buổi sáng', 'không sưng đỏ'],
        multiSelect: true,
      },
      {
        question: 'Bạn có thêm triệu chứng nào?',
        options: ['tê tay chân', 'yếu cơ', 'sốt', 'đau lan xuống chân', 'không có'],
        multiSelect: true,
      },
    ],
  },

  // Aliases for musculoskeletal
  'đau lưng': null,  // resolved at runtime → uses 'đau vai'
  'đau khớp': null,  // resolved at runtime → uses 'đau vai'

  // ═══════════════════════════════════════════════════════════════════════════
  // 8. TÊ TAY CHÂN / YẾU CƠ (Numbness / Weakness)
  // ═══════════════════════════════════════════════════════════════════════════
  'tê tay chân': {
    associatedSymptoms: [
      { text: 'yếu cơ, khó cầm nắm', dangerLevel: 'warning' },
      { text: 'tê một bên cơ thể', dangerLevel: 'danger' },
      { text: 'đau nhức kèm tê', dangerLevel: 'normal' },
      { text: 'kim châm, kiến bò', dangerLevel: 'normal' },
      { text: 'chuột rút', dangerLevel: 'normal' },
      { text: 'mất cảm giác', dangerLevel: 'warning' },
      { text: 'nói ngọng, khó nói', dangerLevel: 'danger' },
      { text: 'mờ mắt đột ngột', dangerLevel: 'danger' },
      { text: 'khó đi lại, mất thăng bằng', dangerLevel: 'danger' },
      { text: 'đau lưng lan xuống chân', dangerLevel: 'warning' },
      { text: 'run tay', dangerLevel: 'warning' },
      { text: 'chóng mặt', dangerLevel: 'normal' },
    ],

    redFlags: [
      'tê hoặc yếu đột ngột một bên cơ thể (nghi đột quỵ)',
      'nói ngọng kèm tê mặt',
      'mất thị lực đột ngột kèm tê',
      'yếu cả hai chân đột ngột',
      'mất kiểm soát tiểu tiện kèm tê chân',
      'tê lan nhanh từ chân lên (nghi Guillain-Barré)',
      'khó thở kèm yếu cơ',
      'sau chấn thương cột sống',
      'co giật kèm tê bì',
    ],

    causes: [
      'ngồi hoặc nằm sai tư thế lâu',
      'tiểu đường (biến chứng thần kinh)',
      'thiếu vitamin B12',
      'thoát vị đĩa đệm',
      'hội chứng ống cổ tay',
      'tuần hoàn máu kém',
      'thuốc đang dùng (hóa trị, thuốc HA)',
      'uống rượu bia nhiều',
      'thiếu máu',
      'stress kéo dài',
    ],

    followUpQuestions: [
      {
        question: 'Tê ở vị trí nào?',
        options: ['bàn tay, ngón tay', 'cánh tay', 'bàn chân, ngón chân', 'cả chân', 'một bên cơ thể', 'cả hai bên'],
        multiSelect: true,
      },
      {
        question: 'Tê xuất hiện kiểu nào?',
        options: ['tê liên tục', 'tê từng lúc rồi hết', 'tê tăng khi nghỉ ngơi', 'tê khi vận động'],
        multiSelect: false,
      },
      {
        question: 'Bạn có thêm triệu chứng nào?',
        options: ['yếu cơ', 'đau nhức', 'chuột rút', 'run tay', 'khó đi lại', 'không có'],
        multiSelect: true,
      },
      {
        question: 'Bạn có bệnh nền nào sau đây?',
        options: ['tiểu đường', 'huyết áp cao', 'bệnh tuyến giáp', 'không có bệnh nền', 'không rõ'],
        multiSelect: true,
      },
    ],
  },

  // Alias
  'yếu cơ': null, // resolved at runtime → uses 'tê tay chân'

  // ═══════════════════════════════════════════════════════════════════════════
  // 9. BUỒN NÔN / NÔN (Nausea / Vomiting)
  // ═══════════════════════════════════════════════════════════════════════════
  'buồn nôn': {
    associatedSymptoms: [
      { text: 'nôn ói', dangerLevel: 'normal' },
      { text: 'đau bụng', dangerLevel: 'normal' },
      { text: 'tiêu chảy', dangerLevel: 'normal' },
      { text: 'sốt', dangerLevel: 'warning' },
      { text: 'đau đầu', dangerLevel: 'normal' },
      { text: 'chóng mặt', dangerLevel: 'normal' },
      { text: 'nôn ra máu', dangerLevel: 'danger' },
      { text: 'nôn ra chất nâu đen', dangerLevel: 'danger' },
      { text: 'đau ngực', dangerLevel: 'danger' },
      { text: 'cứng cổ kèm sốt', dangerLevel: 'danger' },
      { text: 'vàng da', dangerLevel: 'danger' },
      { text: 'khát nước nhiều, tiểu ít', dangerLevel: 'warning' },
      { text: 'chướng bụng', dangerLevel: 'warning' },
    ],

    redFlags: [
      'nôn ra máu hoặc chất nâu đen (bã cà phê)',
      'nôn ói nhiều không cầm, không uống được nước',
      'đau bụng dữ dội kèm nôn',
      'sốt cao kèm cứng cổ kèm nôn (nghi viêm màng não)',
      'đau đầu dữ dội đột ngột kèm nôn',
      'nôn sau chấn thương đầu',
      'vàng da kèm nôn',
      'tiểu rất ít hoặc không tiểu (mất nước nặng)',
      'lú lẫn kèm nôn',
      'đau ngực kèm nôn (nghi nhồi máu cơ tim)',
    ],

    causes: [
      'ngộ độc thực phẩm',
      'ăn đồ không hợp vệ sinh',
      'viêm dạ dày',
      'say tàu xe',
      'thuốc đang dùng (kháng sinh, giảm đau)',
      'căng thẳng, lo âu',
      'trào ngược dạ dày',
      'uống rượu bia',
      'mang thai (phụ nữ)',
      'đau nửa đầu (migraine)',
    ],

    followUpQuestions: [
      {
        question: 'Bạn đã nôn bao nhiêu lần?',
        options: ['chỉ buồn nôn, chưa nôn', '1-2 lần', '3-5 lần', 'trên 5 lần'],
        multiSelect: false,
      },
      {
        question: 'Chất nôn ra như thế nào?',
        options: ['thức ăn', 'nước trong hoặc vàng', 'có lẫn máu hoặc nâu đen', 'không rõ'],
        multiSelect: false,
      },
      {
        question: 'Bạn có uống được nước không?',
        options: ['uống bình thường', 'uống ít, hay nôn lại', 'không uống được gì'],
        multiSelect: false,
      },
      {
        question: 'Bạn có thêm triệu chứng nào?',
        options: ['đau bụng', 'tiêu chảy', 'sốt', 'đau đầu', 'chóng mặt', 'không có'],
        multiSelect: true,
      },
    ],
  },

  // Alias
  'nôn': null, // resolved at runtime → uses 'buồn nôn'

  // ═══════════════════════════════════════════════════════════════════════════
  // 10. SỐT (Fever)
  // ═══════════════════════════════════════════════════════════════════════════
  'sốt': {
    associatedSymptoms: [
      { text: 'ớn lạnh, rét run', dangerLevel: 'normal' },
      { text: 'đau đầu', dangerLevel: 'normal' },
      { text: 'đau nhức cơ thể', dangerLevel: 'normal' },
      { text: 'ho', dangerLevel: 'normal' },
      { text: 'đau họng', dangerLevel: 'normal' },
      { text: 'sổ mũi, nghẹt mũi', dangerLevel: 'normal' },
      { text: 'phát ban, nổi chấm đỏ', dangerLevel: 'danger' },
      { text: 'đau sau hốc mắt', dangerLevel: 'warning' },
      { text: 'xuất huyết (chảy máu nướu, bầm tím)', dangerLevel: 'danger' },
      { text: 'cứng cổ', dangerLevel: 'danger' },
      { text: 'tiểu buốt, tiểu rát', dangerLevel: 'warning' },
      { text: 'tiêu chảy', dangerLevel: 'normal' },
      { text: 'co giật', dangerLevel: 'danger' },
      { text: 'lú lẫn, mê sảng', dangerLevel: 'danger' },
      { text: 'khó thở', dangerLevel: 'danger' },
    ],

    redFlags: [
      'sốt trên 39.5°C không giảm sau uống thuốc',
      'co giật do sốt',
      'cứng cổ kèm sốt (nghi viêm màng não)',
      'phát ban xuất huyết, chấm đỏ không mất khi ấn (nghi sốt xuất huyết)',
      'chảy máu nướu, bầm tím bất thường kèm sốt (nghi sốt xuất huyết)',
      'sốt kèm khó thở nặng',
      'sốt kèm lú lẫn, mê sảng',
      'sốt kéo dài trên 7 ngày',
      'sốt kèm đau bụng dữ dội',
      'sốt kèm tiểu rất ít hoặc không tiểu',
      'sốt ở người suy giảm miễn dịch',
      'sốt rét run kèm vã mồ hôi (nghi sốt rét)',
    ],

    causes: [
      'cảm cúm, nhiễm virus',
      'viêm họng, viêm amidan',
      'nhiễm trùng đường tiểu',
      'sốt xuất huyết (dengue)',
      'viêm phổi',
      'nhiễm trùng vết thương',
      'sau tiêm vaccine',
      'COVID-19 hoặc các virus hô hấp',
      'viêm ruột, ngộ độc thực phẩm',
      'sốt rét (nếu đi vùng dịch)',
    ],

    followUpQuestions: [
      {
        question: 'Nhiệt độ đo được bao nhiêu?',
        options: ['37.5-38°C (sốt nhẹ)', '38-39°C (sốt vừa)', '39-40°C (sốt cao)', 'trên 40°C', 'chưa đo được'],
        multiSelect: false,
      },
      {
        question: 'Sốt từ khi nào?',
        options: ['hôm nay', 'từ hôm qua', '2-3 ngày nay', 'trên 3 ngày', 'trên 1 tuần'],
        multiSelect: false,
      },
      {
        question: 'Sốt kiểu nào?',
        options: ['sốt liên tục', 'sốt rồi hạ rồi sốt lại', 'sốt về chiều/tối', 'sốt cao đột ngột'],
        multiSelect: false,
      },
      {
        question: 'Bạn có thêm triệu chứng nào?',
        options: ['ho', 'đau họng', 'sổ mũi', 'đau đầu', 'phát ban', 'đau sau mắt', 'tiểu buốt', 'không có'],
        multiSelect: true,
      },
      {
        question: 'Bạn đã uống thuốc hạ sốt chưa?',
        options: ['đã uống paracetamol', 'đã uống thuốc khác', 'chưa uống gì', 'uống rồi nhưng không hạ'],
        multiSelect: false,
      },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 11. HO (Cough)
  // ═══════════════════════════════════════════════════════════════════════════
  'ho': {
    associatedSymptoms: [
      { text: 'sốt', dangerLevel: 'warning' },
      { text: 'đau họng', dangerLevel: 'normal' },
      { text: 'sổ mũi, nghẹt mũi', dangerLevel: 'normal' },
      { text: 'khó thở', dangerLevel: 'danger' },
      { text: 'ho ra đờm xanh hoặc vàng', dangerLevel: 'warning' },
      { text: 'ho ra máu', dangerLevel: 'danger' },
      { text: 'đau ngực khi ho', dangerLevel: 'warning' },
      { text: 'thở khò khè', dangerLevel: 'warning' },
      { text: 'sụt cân', dangerLevel: 'danger' },
      { text: 'đổ mồ hôi đêm', dangerLevel: 'danger' },
      { text: 'khàn tiếng', dangerLevel: 'normal' },
      { text: 'mệt mỏi', dangerLevel: 'normal' },
    ],

    redFlags: [
      'ho ra máu',
      'khó thở nặng kèm ho',
      'ho kéo dài trên 2 tuần kèm sốt nhẹ (nghi lao phổi)',
      'ho kèm sụt cân và đổ mồ hôi đêm (nghi lao)',
      'ho kèm đau ngực dữ dội',
      'ho kèm tím môi',
      'ho dữ dội không ngừng ở người cao tuổi',
      'sốt cao kèm ho nhiều đờm (nghi viêm phổi)',
      'ho ở người suy giảm miễn dịch',
      'ho kèm sưng phù chân (nghi suy tim)',
    ],

    causes: [
      'cảm lạnh, viêm đường hô hấp trên',
      'viêm phế quản',
      'hen suyễn',
      'dị ứng (bụi, phấn hoa, thời tiết)',
      'trào ngược dạ dày',
      'hút thuốc lá',
      'ô nhiễm không khí',
      'thuốc ức chế men chuyển (ACE inhibitor)',
      'lao phổi',
      'viêm phổi',
    ],

    followUpQuestions: [
      {
        question: 'Ho kiểu nào?',
        options: ['ho khan, không đờm', 'ho có đờm trắng', 'ho đờm xanh/vàng', 'ho có lẫn máu'],
        multiSelect: false,
      },
      {
        question: 'Ho kéo dài bao lâu?',
        options: ['1-3 ngày', '4-7 ngày', '1-2 tuần', 'trên 2 tuần', 'trên 1 tháng'],
        multiSelect: false,
      },
      {
        question: 'Ho nặng hơn khi nào?',
        options: ['về đêm', 'buổi sáng', 'khi nằm', 'khi gắng sức', 'sau khi ăn', 'suốt ngày'],
        multiSelect: true,
      },
      {
        question: 'Bạn có thêm triệu chứng nào?',
        options: ['sốt', 'đau họng', 'khó thở', 'sổ mũi', 'đau ngực', 'sụt cân', 'không có'],
        multiSelect: true,
      },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 12. MẤT NGỦ (Insomnia)
  // ═══════════════════════════════════════════════════════════════════════════
  'mất ngủ': {
    associatedSymptoms: [
      { text: 'lo lắng, suy nghĩ nhiều', dangerLevel: 'normal' },
      { text: 'mệt mỏi ban ngày', dangerLevel: 'normal' },
      { text: 'đau đầu', dangerLevel: 'normal' },
      { text: 'tim đập nhanh khi nằm', dangerLevel: 'warning' },
      { text: 'khó thở khi nằm', dangerLevel: 'danger' },
      { text: 'đau nhức cơ thể', dangerLevel: 'normal' },
      { text: 'tiểu đêm nhiều lần', dangerLevel: 'warning' },
      { text: 'ngáy to, ngưng thở khi ngủ', dangerLevel: 'warning' },
      { text: 'buồn bã, không muốn làm gì', dangerLevel: 'warning' },
      { text: 'muốn tự làm hại bản thân', dangerLevel: 'danger' },
      { text: 'ợ nóng khi nằm', dangerLevel: 'normal' },
      { text: 'ngứa, khó chịu trên da', dangerLevel: 'normal' },
    ],

    redFlags: [
      'mất ngủ kèm ý định tự tử hoặc tự hại',
      'mất ngủ kèm lú lẫn, mất phương hướng',
      'mất ngủ kèm khó thở khi nằm (nghi suy tim)',
      'mất ngủ kèm đau ngực về đêm',
      'mất ngủ nhiều ngày kèm ảo giác',
      'mất ngủ kèm sốt cao kéo dài',
      'mất ngủ kèm sụt cân nhanh',
    ],

    causes: [
      'căng thẳng, lo âu',
      'trầm cảm',
      'thay đổi giờ giấc sinh hoạt',
      'uống cà phê hoặc trà buổi chiều/tối',
      'dùng điện thoại trước khi ngủ',
      'đau nhức cơ thể',
      'tiểu đêm (phì đại tiền liệt tuyến, tiểu đường)',
      'thuốc đang dùng (corticoid, thuốc HA)',
      'môi trường ngủ không thoải mái',
      'ngưng thở khi ngủ',
    ],

    followUpQuestions: [
      {
        question: 'Mất ngủ kiểu nào?',
        options: ['khó đi vào giấc ngủ', 'ngủ được nhưng hay thức dậy giữa đêm', 'thức dậy quá sớm', 'ngủ không sâu'],
        multiSelect: true,
      },
      {
        question: 'Mất ngủ kéo dài bao lâu?',
        options: ['vài hôm nay', '1-2 tuần', 'trên 1 tháng', 'đã lâu rồi'],
        multiSelect: false,
      },
      {
        question: 'Bạn có thêm triệu chứng nào?',
        options: ['lo lắng nhiều', 'buồn bã', 'mệt mỏi ban ngày', 'đau đầu', 'đau nhức', 'tiểu đêm', 'không có'],
        multiSelect: true,
      },
      {
        question: 'Bạn đã thử gì để ngủ tốt hơn?',
        options: ['uống thuốc ngủ', 'uống trà thảo mộc', 'tập thể dục', 'hạn chế cà phê', 'chưa thử gì'],
        multiSelect: true,
      },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 13. ĐAU HỌNG (Sore Throat)
  // ═══════════════════════════════════════════════════════════════════════════
  'đau họng': {
    associatedSymptoms: [
      { text: 'sốt', dangerLevel: 'warning' },
      { text: 'ho', dangerLevel: 'normal' },
      { text: 'sổ mũi, nghẹt mũi', dangerLevel: 'normal' },
      { text: 'khó nuốt', dangerLevel: 'warning' },
      { text: 'sưng hạch cổ', dangerLevel: 'warning' },
      { text: 'khàn tiếng', dangerLevel: 'normal' },
      { text: 'đau tai', dangerLevel: 'normal' },
      { text: 'không nuốt được nước bọt', dangerLevel: 'danger' },
      { text: 'khó thở', dangerLevel: 'danger' },
      { text: 'khó há miệng', dangerLevel: 'danger' },
      { text: 'phát ban trên người', dangerLevel: 'warning' },
      { text: 'mệt mỏi', dangerLevel: 'normal' },
    ],

    redFlags: [
      'không nuốt được nước bọt, chảy dãi',
      'khó thở kèm đau họng (nghi viêm nắp thanh quản)',
      'khó há miệng (nghi áp xe quanh amidan)',
      'sốt cao trên 39°C kèm đau họng dữ dội',
      'sưng cổ rõ rệt, lan rộng',
      'giọng bị bóp nghẹt (hot potato voice)',
      'đau họng kèm phát ban toàn thân',
      'đau họng kéo dài trên 2 tuần không đỡ',
      'khàn tiếng kéo dài trên 3 tuần',
    ],

    causes: [
      'viêm họng do virus (cảm cúm)',
      'viêm họng do liên cầu khuẩn',
      'viêm amidan',
      'trào ngược dạ dày',
      'nói nhiều, la hét',
      'khí hậu khô, điều hòa lạnh',
      'hút thuốc lá hoặc hít khói',
      'dị ứng',
      'thở bằng miệng khi ngủ',
      'uống đồ quá nóng hoặc quá lạnh',
    ],

    followUpQuestions: [
      {
        question: 'Mức độ đau họng?',
        options: ['ngứa rát nhẹ', 'đau khi nuốt', 'đau nhiều, khó ăn uống', 'không nuốt được'],
        multiSelect: false,
      },
      {
        question: 'Bạn có thêm triệu chứng nào?',
        options: ['sốt', 'ho', 'sổ mũi', 'sưng hạch cổ', 'khàn tiếng', 'khó thở', 'không có'],
        multiSelect: true,
      },
      {
        question: 'Đau họng kéo dài bao lâu?',
        options: ['1-2 ngày', '3-5 ngày', '1-2 tuần', 'trên 2 tuần'],
        multiSelect: false,
      },
      {
        question: 'Bạn đã đo nhiệt độ chưa?',
        options: ['không sốt', 'sốt nhẹ (37.5-38°C)', 'sốt vừa (38-39°C)', 'sốt cao (trên 39°C)', 'chưa đo'],
        multiSelect: false,
      },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 14. TIÊU CHẢY (Diarrhea)
  // ═══════════════════════════════════════════════════════════════════════════
  'tiêu chảy': {
    associatedSymptoms: [
      { text: 'đau bụng quặn', dangerLevel: 'normal' },
      { text: 'buồn nôn hoặc nôn', dangerLevel: 'normal' },
      { text: 'sốt', dangerLevel: 'warning' },
      { text: 'phân có máu hoặc nhầy máu', dangerLevel: 'danger' },
      { text: 'phân đen', dangerLevel: 'danger' },
      { text: 'khát nước nhiều, miệng khô', dangerLevel: 'warning' },
      { text: 'tiểu ít hoặc nước tiểu sẫm màu', dangerLevel: 'warning' },
      { text: 'chóng mặt khi đứng dậy', dangerLevel: 'warning' },
      { text: 'mệt mỏi', dangerLevel: 'normal' },
      { text: 'chuột rút', dangerLevel: 'normal' },
      { text: 'sụt cân', dangerLevel: 'warning' },
      { text: 'ngất xỉu', dangerLevel: 'danger' },
    ],

    redFlags: [
      'tiêu chảy có máu (phân nhầy máu hoặc phân đen)',
      'tiêu chảy trên 6 lần/ngày kèm mất nước',
      'không uống được nước, nôn liên tục',
      'sốt cao trên 39°C kèm tiêu chảy',
      'tiểu rất ít hoặc không tiểu (mất nước nặng)',
      'ngất hoặc choáng kèm tiêu chảy',
      'tiêu chảy kéo dài trên 3 ngày không đỡ',
      'tiêu chảy ở người cao tuổi kèm mệt lả',
      'tiêu chảy ở người tiểu đường (nguy cơ hạ đường huyết)',
      'đau bụng dữ dội kèm tiêu chảy',
    ],

    causes: [
      'ngộ độc thực phẩm',
      'ăn đồ không hợp vệ sinh',
      'nhiễm virus (rotavirus, norovirus)',
      'nhiễm khuẩn đường ruột',
      'thuốc kháng sinh',
      'không dung nạp lactose',
      'hội chứng ruột kích thích',
      'ăn đồ lạ, thức ăn đường phố',
      'nước uống không sạch',
      'căng thẳng, lo âu',
    ],

    followUpQuestions: [
      {
        question: 'Đi ngoài bao nhiêu lần trong ngày?',
        options: ['2-3 lần', '4-5 lần', '6-10 lần', 'trên 10 lần'],
        multiSelect: false,
      },
      {
        question: 'Phân như thế nào?',
        options: ['lỏng nước', 'sệt, không thành khuôn', 'có nhầy', 'có máu hoặc nâu đen', 'không rõ'],
        multiSelect: false,
      },
      {
        question: 'Bạn có uống đủ nước không?',
        options: ['uống bình thường', 'uống ít vì buồn nôn', 'không uống được gì', 'đang uống oresol'],
        multiSelect: false,
      },
      {
        question: 'Bạn có thêm triệu chứng nào?',
        options: ['đau bụng', 'sốt', 'buồn nôn', 'chóng mặt', 'tiểu ít', 'mệt lả', 'không có'],
        multiSelect: true,
      },
      {
        question: 'Bạn có ăn gì lạ gần đây không?',
        options: ['có, ăn ngoài hàng quán', 'có, thức ăn để qua đêm', 'không, ăn uống bình thường', 'không rõ'],
        multiSelect: false,
      },
    ],
  },
};

// ─── Alias resolution ──────────────────────────────────────────────────────
// Some complaints are aliases that should resolve to a primary entry.
const ALIASES = {
  'tức ngực': 'đau ngực',
  'đau lưng': 'đau vai',
  'đau khớp': 'đau vai',
  'yếu cơ': 'tê tay chân',
  'nôn': 'buồn nôn',
  'nôn ói': 'buồn nôn',
  'nhức đầu': 'đau đầu',
  'hoa mắt': 'chóng mặt',
  'choáng': 'chóng mặt',
  'kiệt sức': 'mệt mỏi',
  'mệt': 'mệt mỏi',
  'đau bao tử': 'đau bụng',
  'đau dạ dày': 'đau bụng',
  'tê bì': 'tê tay chân',
  'tê chân': 'tê tay chân',
  'tê tay': 'tê tay chân',
  'ho khan': 'ho',
  'ho đờm': 'ho',
  'khó ngủ': 'mất ngủ',
  'không ngủ được': 'mất ngủ',
  'viêm họng': 'đau họng',
  'rát họng': 'đau họng',
  'đi ngoài': 'tiêu chảy',
  'đi phân lỏng': 'tiêu chảy',
  'sốt cao': 'sốt',
  'sốt nhẹ': 'sốt',
  'đau tim': 'đau ngực',
  'đau cổ': 'đau vai',
  'đau gối': 'đau vai',
  'đau hông': 'đau vai',
};

/**
 * Resolve a chief complaint string to its clinical mapping entry.
 * Handles exact match, alias lookup, and partial/fuzzy matching.
 *
 * @param {string} complaint - the chief complaint text (Vietnamese)
 * @returns {{ key: string, data: object } | null}
 */
function resolveComplaint(complaint) {
  if (!complaint) return null;
  const normalized = complaint.toLowerCase().trim();

  // 1. Exact match
  if (symptomMap[normalized] && symptomMap[normalized] !== null) {
    return { key: normalized, data: symptomMap[normalized] };
  }

  // 2. Alias resolution
  if (ALIASES[normalized]) {
    const target = ALIASES[normalized];
    return { key: target, data: symptomMap[target] };
  }

  // 3. Null-alias entries in symptomMap itself
  if (symptomMap[normalized] === null) {
    for (const [alias, target] of Object.entries(ALIASES)) {
      if (alias === normalized) {
        return { key: target, data: symptomMap[target] };
      }
    }
  }

  // 4. Partial match — complaint contains a known key
  for (const key of Object.keys(symptomMap)) {
    if (symptomMap[key] === null) continue;
    if (normalized.includes(key) || key.includes(normalized)) {
      return { key, data: symptomMap[key] };
    }
  }

  // 5. Partial match against aliases
  for (const [alias, target] of Object.entries(ALIASES)) {
    if (normalized.includes(alias) || alias.includes(normalized)) {
      return { key: target, data: symptomMap[target] };
    }
  }

  return null;
}

/**
 * Get red flags for a complaint. Returns string[] or empty array.
 */
function getRedFlags(complaint) {
  const resolved = resolveComplaint(complaint);
  return resolved ? resolved.data.redFlags : [];
}

/**
 * Check if an answer matches any red flag for the given complaint.
 * @param {string} complaint
 * @param {string|string[]} answers
 * @returns {boolean}
 */
function hasRedFlag(complaint, answers) {
  const flags = getRedFlags(complaint);
  if (!flags.length) return false;

  const answerList = Array.isArray(answers) ? answers : [answers];
  const normalizedFlags = flags.map(f => f.toLowerCase());

  for (const ans of answerList) {
    const normalizedAns = (ans || '').toLowerCase();
    for (const flag of normalizedFlags) {
      if (normalizedAns.includes(flag) || flag.includes(normalizedAns)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Get danger-level associated symptoms for a complaint.
 * @param {string} complaint
 * @param {'danger'|'warning'|'normal'} [minLevel] - minimum danger level to include
 * @returns {Array<{text: string, dangerLevel: string}>}
 */
function getAssociatedSymptoms(complaint, minLevel) {
  const resolved = resolveComplaint(complaint);
  if (!resolved) return [];

  const symptoms = resolved.data.associatedSymptoms;
  if (!minLevel) return symptoms;

  const levels = { danger: 3, warning: 2, normal: 1 };
  const minScore = levels[minLevel] || 1;
  return symptoms.filter(s => (levels[s.dangerLevel] || 1) >= minScore);
}

/**
 * Get follow-up questions for a complaint.
 * @param {string} complaint
 * @returns {Array<{question: string, options: string[], multiSelect: boolean}>}
 */
function getFollowUpQuestions(complaint) {
  const resolved = resolveComplaint(complaint);
  return resolved ? resolved.data.followUpQuestions : [];
}

/**
 * Get possible causes for a complaint.
 * @param {string} complaint
 * @returns {string[]}
 */
function getCauses(complaint) {
  const resolved = resolveComplaint(complaint);
  return resolved ? resolved.data.causes : [];
}

/**
 * List all supported chief complaints (primary keys only, no aliases).
 * @returns {string[]}
 */
function listComplaints() {
  return Object.keys(symptomMap).filter(k => symptomMap[k] !== null);
}

module.exports = {
  symptomMap,
  ALIASES,
  resolveComplaint,
  getRedFlags,
  hasRedFlag,
  getAssociatedSymptoms,
  getFollowUpQuestions,
  getCauses,
  listComplaints,
};
