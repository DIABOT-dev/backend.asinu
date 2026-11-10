-- Editorial refresh for older readers. Wishes/reflections are original Asinu copy.
-- Folk sayings retain their traditional wording; the following paragraph is an
-- editorial invitation, not part of the quotation or a promise of medical benefit.
-- Update only exact, unreviewed seed text. Preserve operator edits, activation
-- decisions, clinical review records, and every previously assigned gift snapshot.
-- Tips remain inactive until a professional reviews them through the content API.
-- Sources checked 2026-11-08 (paraphrased, no treatment/dose/blanket exercise targets):
-- Sleep (05-07, 11): https://www.nia.nih.gov/health/infographics/getting-good-nights-sleep
-- Lighting/clear paths (01, 03): https://www.nia.nih.gov/health/falls-and-falls-prevention/preventing-falls-home-room-room
-- Footwear (02): https://www.cdc.gov/vision-health/prevention/older-adult-falls.html
-- Reach/bathroom safety (04, 12): https://medlineplus.gov/ency/patientinstructions/000052.htm
-- Social contact (08-09): https://www.nia.nih.gov/health/loneliness-and-social-isolation/loneliness-and-social-isolation-tips-staying-connected
-- Movement (10): https://www.who.int/news-room/fact-sheets/detail/physical-activity
-- Traditional wording example: https://thpthoangvanthuhn.edu.vn/upload/1003475/20251016/Nguyen_Minh_Duy_HDTN_khoi_11_5f810.pdf

WITH original AS (
SELECT 'welcome_' || lpad(n::text, 2, '0') AS code,
  (ARRAY[
    'Chúc bạn một ngày bình yên.', 'Mong hôm nay có một điều làm bạn mỉm cười.',
    'Chúc mái nhà luôn đầy tiếng cười.', 'Mong niềm vui ghé thăm bạn hôm nay.',
    'Chúc bạn có một buổi sáng thật nhẹ nhàng.', 'Mong những điều nhỏ bé mang lại niềm vui.',
    'Chúc gia đình mình luôn gần nhau trong yêu thương.', 'Mong hôm nay là một ngày ấm áp.',
    'Chúc bạn có thời gian cho những điều mình thích.', 'Mong bạn luôn được lắng nghe.'
  ])[((n - 1) % 10) + 1] || ' ' ||
  (ARRAY[
    'Cả nhà luôn nhớ đến bạn.', 'Một lời hỏi thăm cũng làm ngày thêm ấm.',
    'Bình yên bắt đầu từ những điều giản dị.', 'Yêu thương không ngại khoảng cách.',
    'Mỗi lần gặp nhau là một niềm vui.', 'Bạn xứng đáng với những điều dịu dàng.'
  ])[((n - 1) / 10) + 1] AS old_text,
  (ARRAY[
    'Wishing you a peaceful day.', 'May something make you smile today.',
    'May your home be full of laughter.', 'May a little joy find you today.',
    'Wishing you a gentle morning.', 'May small moments bring you joy.',
    'May your family stay close in love.', 'Wishing you warmth today.',
    'May you find time for what you enjoy.', 'May you always feel heard.'
  ])[((n - 1) % 10) + 1] || ' ' ||
  (ARRAY[
    'Your family is thinking of you.', 'A kind hello can brighten a day.',
    'Peace can be found in simple things.', 'Love travels across distances.',
    'Every reunion is a joy.', 'You deserve gentle moments.'
  ])[((n - 1) / 10) + 1] AS old_text_en
FROM generate_series(1, 60) n
), replacement AS (
SELECT 'welcome_' || lpad(n::text, 2, '0') AS code,
  (ARRAY[
    E'Chúc bạn hôm nay ăn thấy ngon miệng, đêm đến có giấc ngủ êm.',
    E'Chúc bạn một ngày thư thái, làm điều mình thích mà không phải vội.',
    E'Mong hôm nay bạn thấy trong người dễ chịu và có thêm một chuyện vui.',
    E'Chúc bữa cơm hôm nay ấm cúng, có người cùng trò chuyện và lắng nghe.',
    E'Chúc bạn buổi sáng khoan thai, buổi tối an lòng nghỉ ngơi.',
    E'Mong bạn luôn thấy mình được quan tâm, cả trong những ngày không khỏe.',
    E'Chúc bạn giữ được niềm vui với chậu cây, trang sách hay bản nhạc mình yêu.',
    E'Chúc bạn bước đi vững vàng, thong thả theo nhịp của mình.',
    E'Mong mỗi ngày của bạn có một cuộc hỏi thăm thật ấm lòng.',
    E'Chúc bạn một ngày nhẹ nhõm, việc khó có người cùng chia sẻ.',
    E'Mong bạn luôn có thời gian để nghỉ ngơi và chăm chút cho bản thân.',
    E'Chúc bạn tìm thấy niềm vui trong những việc vừa sức hôm nay.'
  ])[((n-1)%12)+1] || ' ' || (ARRAY[
    E'Chăm mình từng chút mỗi ngày cũng là một điều đáng quý.',
    E'Hôm nay dễ chịu hơn một chút cũng đã là niềm vui rồi.',
    E'Không cần cố hơn sức mình; bạn cứ thong thả nhé.',
    E'Bạn luôn xứng đáng được lắng nghe và chăm sóc.',
    E'Mong một lời hỏi thăm mang đến cho bạn thêm chút ấm áp.'
  ])[((n-1)/12)+1] AS text,
  (ARRAY[
    E'May your meals be enjoyable today and your sleep peaceful tonight.',
    E'Wishing you an unhurried day with time for something you enjoy.',
    E'May you feel comfortable today and find another reason to smile.',
    E'May today bring a warm meal and someone to listen and talk with.',
    E'Wishing you a gentle morning and a restful evening.',
    E'May you feel cared for, including on days when you do not feel well.',
    E'May your plants, a good book or a favorite song bring you joy.',
    E'May your steps feel steady as you go at your own pace.',
    E'May a warm conversation brighten each day for you.',
    E'Wishing you a lighter day and someone to share its difficulties.',
    E'May you have time to rest and take care of yourself.',
    E'May the things you can comfortably do today bring you joy.'
  ])[((n-1)%12)+1] || ' ' || (ARRAY[
    E'The small ways you care for yourself each day matter.',
    E'Feeling a little more comfortable today is worth appreciating.',
    E'There is no need to push yourself; take your time.',
    E'You deserve to be heard and cared for.',
    E'May a kind hello bring a little extra warmth to your day.'
  ])[((n-1)/12)+1] AS text_en
FROM generate_series(1, 60) n
)
UPDATE loc_items item SET text=replacement.text, text_en=replacement.text_en, updated_at=NOW()
FROM original JOIN replacement USING (code)
WHERE item.code=original.code AND item.type='wish'
  AND item.text=original.old_text AND item.text_en=original.old_text_en
  AND item.reviewed_by IS NULL AND item.reviewed_at IS NULL;

WITH replacement(code, old_text, old_text_en, text, text_en) AS (VALUES
(E'proverb_01',E'Bầu ơi thương lấy bí cùng,\nTuy rằng khác giống nhưng chung một giàn.',E'Though the gourds may differ, they share one trellis and care for one another.',E'Bầu ơi thương lấy bí cùng,\nTuy rằng khác giống nhưng chung một giàn.\n\nCó điều gì lo về sức khỏe, mình cứ chia sẻ với người tin cậy. Được lắng nghe cũng là một sự nâng đỡ.',E'Though the gourds may differ, they share one trellis and care for one another.\n\nIf a health concern is on your mind, share it with someone you trust. Being heard can be a comfort.'),
(E'proverb_02',E'Một cây làm chẳng nên non,\nBa cây chụm lại nên hòn núi cao.',E'One tree stands alone; together, many trees make a mountain.',E'Một cây làm chẳng nên non,\nBa cây chụm lại nên hòn núi cao.\n\nViệc gì thấy quá sức, mình có thể nhờ con cháu hoặc hàng xóm giúp một tay.',E'One tree stands alone; together, many trees make a mountain.\n\nWhen a task feels too much, you can ask family or a neighbor for a hand.'),
(E'proverb_03',E'Nhiễu điều phủ lấy giá gương,\nNgười trong một nước phải thương nhau cùng.',E'As a fine cloth shelters a mirror, people should shelter one another with kindness.',E'Nhiễu điều phủ lấy giá gương,\nNgười trong một nước phải thương nhau cùng.\n\nMột lời hỏi thăm chân thành có thể làm ấm lòng người đang mệt. Hôm nay, mình gửi lời ấy cho ai nhé?',E'As a fine cloth shelters a mirror, people should shelter one another with kindness.\n\nA thoughtful hello can comfort someone who feels tired. Who might you reach out to today?'),
(E'proverb_04',E'Có công mài sắt, có ngày nên kim.',E'With patience, an iron bar can become a needle.',E'Có công mài sắt, có ngày nên kim.\n\nChăm sức khỏe cũng cần kiên nhẫn. Mình quý từng việc nhỏ làm được, không cần so với người khác.',E'With patience, an iron bar can become a needle.\n\nCaring for yourself takes patience. Appreciate each small thing you can do without comparing yourself with others.'),
(E'proverb_05',E'Ăn quả nhớ kẻ trồng cây.',E'When enjoying the fruit, remember the person who planted the tree.',E'Ăn quả nhớ kẻ trồng cây.\n\nHôm nay, mình thử nhắc lại một kỷ niệm vui với người từng chăm sóc mình.',E'When enjoying the fruit, remember the person who planted the tree.\n\nPerhaps today you could share a happy memory with someone who has cared for you.'),
(E'proverb_06',E'Uống nước nhớ nguồn.',E'When drinking water, remember its source.',E'Uống nước nhớ nguồn.\n\nMột lời cảm ơn dành cho người đang chăm sóc mình cũng là món quà ấm áp.',E'When drinking water, remember its source.\n\nA thank-you to someone who cares for you is a warm gift in itself.'),
(E'proverb_07',E'Lá lành đùm lá rách.',E'Let those who have enough help those who have less.',E'Lá lành đùm lá rách.\n\nKhi khỏe, mình hỏi thăm người đang mệt. Khi cần giúp, mình cũng đừng ngại mở lời.',E'Let those who have enough help those who have less.\n\nWhen you feel well, check on someone who is tired. When you need help, it is all right to ask.'),
(E'proverb_08',E'Một miếng khi đói bằng một gói khi no.',E'A small kindness in a time of need can mean more than plenty in a time of comfort.',E'Một miếng khi đói bằng một gói khi no.\n\nĐôi khi người đang mệt chỉ cần một người ngồi nghe. Mình hỏi họ cần gì trước khi giúp nhé.',E'A small kindness in a time of need can mean more than plenty in a time of comfort.\n\nSometimes a person who feels unwell wants someone to listen. Ask what they need before offering help.'),
(E'proverb_09',E'Lời nói chẳng mất tiền mua,\nLựa lời mà nói cho vừa lòng nhau.',E'Words cost nothing; choose them with care for one another.',E'Lời nói chẳng mất tiền mua,\nLựa lời mà nói cho vừa lòng nhau.\n\nHôm nay, mình dành cho người thân một lời hỏi thăm. Có chuyện sức khỏe còn băn khoăn, cứ chia sẻ để được cùng hỗ trợ.',E'Words cost nothing; choose them with care for one another.\n\nReach out to someone close today. If a health concern is worrying you, sharing it can help you seek support together.'),
(E'proverb_10',E'Anh em như thể tay chân,\nRách lành đùm bọc, dở hay đỡ đần.',E'Family stays close and lends a hand through good times and hard times.',E'Anh em như thể tay chân,\nRách lành đùm bọc, dở hay đỡ đần.\n\nNếu có buổi khám sắp tới, mình có thể nhờ người thân đi cùng để nghe và ghi lại hướng dẫn.',E'Family stays close and lends a hand through good times and hard times.\n\nIf you have an appointment coming up, you can ask a relative to come along and help listen and take notes.'),
(E'proverb_11',E'Đi một ngày đàng, học một sàng khôn.',E'Every journey brings something new to learn.',E'Đi một ngày đàng, học một sàng khôn.\n\nMột điều mới về cách chăm mình cũng đáng vui. Chưa rõ điều gì, mình cứ hỏi chuyên gia bằng lời quen thuộc.',E'Every journey brings something new to learn.\n\nLearning something new about caring for yourself is worth enjoying. Ask a health professional in your own words when something is unclear.'),
(E'proverb_12',E'Góp gió thành bão.',E'Small efforts gathered together can become something great.',E'Góp gió thành bão.\n\nNhững việc nhỏ như ngủ đúng giờ quen thuộc, giữ lối đi gọn gàng đều đáng được mình để tâm.',E'Small efforts gathered together can become something great.\n\nSmall routines, such as keeping your usual bedtime and a clear walkway, deserve your attention.'),
(E'proverb_13',E'Tích tiểu thành đại.',E'Many small things can add up to something great.',E'Tích tiểu thành đại.\n\nMình không cần làm hết mọi việc trong một ngày. Chọn một việc vừa sức rồi thong thả làm nhé.',E'Many small things can add up to something great.\n\nThere is no need to do everything in one day. Choose one manageable task and take your time.'),
(E'proverb_14',E'Chị ngã em nâng.',E'When one sibling stumbles, another helps them up.',E'Chị ngã em nâng.\n\nKhi thấy một việc không an toàn, mình dừng lại và nhờ giúp. Nhận sự hỗ trợ không có gì phải ngại.',E'When one sibling stumbles, another helps them up.\n\nIf a task feels unsafe, stop and ask for help. There is no shame in accepting support.'),
(E'proverb_15',E'Bán anh em xa, mua láng giềng gần.',E'Treasure the neighbors who are close enough to lend a hand.',E'Bán anh em xa, mua láng giềng gần.\n\nCó thể chào hỏi một người hàng xóm mình tin cậy. Những mối quen gần nhà cũng đáng được vun đắp.',E'Treasure the neighbors who are close enough to lend a hand.\n\nSay hello to a neighbor you trust. Connections close to home are worth nurturing.'),
(E'proverb_16',E'Một con ngựa đau, cả tàu bỏ cỏ.',E'When one is hurting, the whole family feels concern.',E'Một con ngựa đau, cả tàu bỏ cỏ.\n\nKhi trong nhà có người không khỏe, một câu hỏi họ cần gì sẽ thiết thực hơn lời đoán bệnh.',E'When one is hurting, the whole family feels concern.\n\nWhen someone at home feels unwell, asking what they need is more helpful than guessing an illness.'),
(E'proverb_17',E'Thương người như thể thương thân.',E'Care for others as you care for yourself.',E'Thương người như thể thương thân.\n\nMình quan tâm đến người khác, cũng nhớ chừa thời gian nghỉ ngơi cho chính mình nhé.',E'Care for others as you care for yourself.\n\nWhile caring for others, remember to leave time for your own rest too.'),
(E'proverb_18',E'Đói cho sạch, rách cho thơm.',E'Keep your dignity and kindness, even in difficult times.',E'Đói cho sạch, rách cho thơm.\n\nĂn mặc giản dị cũng được, miễn mình thấy thoải mái. Sức khỏe không phải cuộc đua với ai.',E'Keep your dignity and kindness, even in difficult times.\n\nSimple, comfortable clothing is enough. Looking after yourself is not a competition.'),
(E'proverb_19',E'Ở hiền gặp lành.',E'May kindness find kindness in return.',E'Ở hiền gặp lành.\n\nMột việc tử tế nhỏ cũng đáng quý. Mình có thể bắt đầu bằng cách nói dịu dàng với chính mình.',E'May kindness find kindness in return.\n\nA small act of kindness matters. You can start by speaking gently to yourself.'),
(E'proverb_20',E'Kiến tha lâu cũng đầy tổ.',E'Little by little, steady effort fills the nest.',E'Kiến tha lâu cũng đầy tổ.\n\nMỗi ngày giữ một thói quen tốt vừa sức là điều đáng quý. Hôm nay mình chọn việc gì nhỉ?',E'Little by little, steady effort fills the nest.\n\nA small, manageable daily habit is worth keeping. What would you like to choose today?')
)
UPDATE loc_items item SET text=replacement.text, text_en=replacement.text_en, updated_at=NOW()
FROM replacement
WHERE item.code=replacement.code AND item.type='proverb'
  AND item.text=replacement.old_text AND item.text_en=replacement.old_text_en
  AND item.reviewed_by IS NULL AND item.reviewed_at IS NULL;

WITH replacement(code, old_text, old_text_en, text, text_en) AS (VALUES
(E'tip_draft_01',E'Để sẵn cuốn sổ và cây bút ở nơi dễ thấy, bạn sẽ tiện ghi lại điều muốn hỏi bác sĩ.',E'Keep a notebook and pen somewhere easy to see, ready to write down questions for your doctor.',E'Trước khi đi ngủ, mình dọn gọn lối từ giường ra nhà vệ sinh và để đèn ở chỗ dễ bật. Nếu cần dời đồ nặng hoặc lắp đèn, nhờ người nhà giúp nhé.',E'Before bed, clear the path from your bed to the bathroom and keep a light within easy reach. Ask someone to help move heavy furniture or install lights.'),
(E'tip_draft_02',E'Trước buổi tư vấn, bạn có thể ghi ngắn gọn điều đang làm mình băn khoăn.',E'Before a consultation, jot down the main thing you would like to discuss.',E'Dép đi trong nhà nên vừa chân, đế bám và không dễ tuột. Đôi dép đã mòn trơn thì mình đổi đôi khác để đi lại vững hơn nhé.',E'Choose well-fitting indoor footwear with a secure, nonslip sole. Replace slippers whose soles have become smooth or slippery.'),
(E'tip_draft_03',E'Khi ghi lại một chỉ số, nhớ ghi cả thời điểm đo để tiện xem lại.',E'When recording a measurement, include the time so it is easier to review later.',E'Thảm bị cuộn mép hoặc dây điện vắt ngang lối đi rất dễ làm vướng chân. Mình nhờ người nhà cố định lại hoặc dọn gọn nhé.',E'Loose rug edges and cables across a walkway can catch your feet. Ask someone to secure them or clear them away.'),
(E'tip_draft_04',E'Để giấy tờ khám bệnh cùng một chỗ sẽ giúp bạn tìm lại dễ hơn khi cần.',E'Keeping your medical papers together makes them easier to find when needed.',E'Điện thoại, kính và đồ hay dùng nên để ở nơi dễ với. Muốn lấy món trên cao, mình nhờ người khác giúp thay vì trèo lên ghế nhé.',E'Keep your phone, glasses and everyday items within easy reach. Ask for help with high shelves rather than climbing on a chair.'),
(E'tip_draft_05',E'Bạn có thể nhờ người thân cùng ghi lại những điều cần hỏi trong lần tư vấn tiếp theo.',E'A family member can help you write down questions for your next consultation.',E'Tối nay, mình thử đi ngủ và sáng mai thức dậy gần giờ quen thuộc. Giữ nhịp sinh hoạt đều sẽ giúp cơ thể dễ chuẩn bị cho giấc ngủ hơn.',E'Try going to bed and getting up around your usual times. A regular routine helps your body prepare for sleep.'),
(E'tip_draft_06',E'Nếu chưa nghe rõ câu hỏi, bạn cứ bấm nghe lại rồi trả lời theo điều mình nhớ.',E'If you did not hear a question clearly, play it again before answering.',E'Gần giờ ngủ, mình để điện thoại sang một bên, giảm tiếng tivi và chọn một việc thư giãn quen thuộc. Phòng ngủ yên tĩnh sẽ dễ nghỉ ngơi hơn.',E'As bedtime approaches, put your phone aside, turn down the television and choose a familiar relaxing activity. Keep your bedroom quiet for rest.'),
(E'tip_draft_07',E'Khi không nhớ rõ một thông tin, bạn cứ nói chưa rõ để bác sĩ hỏi thêm.',E'If you do not remember something clearly, let your doctor know.',E'Nếu hay khó ngủ buổi tối, mình thử tránh trà đặc hoặc cà phê vào chiều muộn. Thói quen nhỏ này có thể giúp giấc ngủ dễ chịu hơn.',E'If falling asleep is difficult, try avoiding strong tea or coffee late in the day. This small change may make bedtime easier.'),
(E'tip_draft_08',E'Trước khi gửi ghi âm, bạn có thể nghe lại để chắc rằng lời nhắn đã rõ.',E'You can listen to a recording before sending it to check that your message is clear.',E'Một cuộc gọi ngắn hỏi thăm con cháu hoặc bạn cũ cũng đáng quý. Mình có thể hẹn một giờ thuận tiện để cả hai cùng trò chuyện thoải mái.',E'A short call with family or an old friend can be worth making. Arrange a convenient time so neither person feels rushed.'),
(E'tip_draft_09',E'Ghi tên và ngày của mỗi lần khám sẽ giúp bạn sắp xếp hồ sơ dễ hơn.',E'Labeling each visit with its name and date helps keep your records organized.',E'Nếu thấy ngày dài và ít người trò chuyện, mình thử tìm một sinh hoạt quen thuộc ở khu phố hoặc nhóm có chung sở thích. Chọn nơi phù hợp với sức mình nhé.',E'If your days feel lonely, consider a familiar neighborhood activity or a group sharing your interests. Choose something comfortable and accessible for you.'),
(E'tip_draft_10',E'Bạn có thể lưu câu hỏi vừa nghĩ ra vào sổ, để lần tư vấn tới không quên.',E'Write down a question when it comes to mind so you remember it at your next consultation.',E'Nếu sức khỏe cho phép, mình xen những quãng vận động vừa sức vào lúc ngồi lâu. Có thể bắt đầu bằng việc đi lại nhẹ trong nhà, không cần cố theo người khác.',E'If your health allows, break up long periods of sitting with movement you can comfortably manage. A little gentle movement at home is a possible start.'),
(E'tip_draft_11',E'Khi trao đổi với bác sĩ, bạn cứ dùng từ quen thuộc để kể điều mình đang cảm thấy.',E'Use your own everyday words to describe how you feel when talking with your doctor.',E'Buổi tối, mình tránh một bữa ăn quá no sát giờ ngủ. Nếu có hướng dẫn ăn uống riêng từ bác sĩ, mình cứ theo hướng dẫn đó nhé.',E'Avoid a very large meal close to bedtime. If you have an individual eating plan from your clinician, continue to follow it.'),
(E'tip_draft_12',E'Nếu hướng dẫn nào chưa rõ, bạn có thể nhờ bác sĩ giải thích lại bằng cách dễ hiểu hơn.',E'If an instruction is unclear, ask your doctor to explain it in simpler words.',E'Chỗ tắm dễ trơn, mình giữ lối vào khô và nhờ người nhà xem lại thảm chống trượt hoặc tay vịn. Không tự vịn vào móc khăn hay đồ dễ xê dịch nhé.',E'Keep the bathroom entrance dry and ask someone to check nonslip surfaces or grab bars. Do not rely on a towel rail or movable furniture for support.')
)
UPDATE loc_items item SET text=replacement.text, text_en=replacement.text_en, updated_at=NOW()
FROM replacement
WHERE item.code=replacement.code AND item.type='health_tip' AND NOT item.active
  AND item.text=replacement.old_text AND item.text_en=replacement.old_text_en
  AND item.reviewed_by IS NULL AND item.reviewed_at IS NULL;
