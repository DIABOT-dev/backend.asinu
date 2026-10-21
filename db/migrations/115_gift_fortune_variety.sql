-- Add traditional sayings to the live catalog. Health-tip drafts stay inactive
-- until a medical reviewer approves them through the existing content API.
-- Never rewrite loc_snapshot on a gift already assigned to a household.
INSERT INTO loc_items (code, type, text, text_en, serif, active)
VALUES
('proverb_01', 'proverb', E'Bầu ơi thương lấy bí cùng,\nTuy rằng khác giống nhưng chung một giàn.', 'Though the gourds may differ, they share one trellis and care for one another.', TRUE, TRUE),
('proverb_02', 'proverb', E'Một cây làm chẳng nên non,\nBa cây chụm lại nên hòn núi cao.', 'One tree stands alone; together, many trees make a mountain.', TRUE, TRUE),
('proverb_03', 'proverb', E'Nhiễu điều phủ lấy giá gương,\nNgười trong một nước phải thương nhau cùng.', 'As a fine cloth shelters a mirror, people should shelter one another with kindness.', TRUE, TRUE),
('proverb_04', 'proverb', 'Có công mài sắt, có ngày nên kim.', 'With patience, an iron bar can become a needle.', TRUE, TRUE),
('proverb_05', 'proverb', 'Ăn quả nhớ kẻ trồng cây.', 'When enjoying the fruit, remember the person who planted the tree.', TRUE, TRUE),
('proverb_06', 'proverb', 'Uống nước nhớ nguồn.', 'When drinking water, remember its source.', TRUE, TRUE),
('proverb_07', 'proverb', 'Lá lành đùm lá rách.', 'Let those who have enough help those who have less.', TRUE, TRUE),
('proverb_08', 'proverb', 'Một miếng khi đói bằng một gói khi no.', 'A small kindness in a time of need can mean more than plenty in a time of comfort.', TRUE, TRUE),
('proverb_09', 'proverb', E'Lời nói chẳng mất tiền mua,\nLựa lời mà nói cho vừa lòng nhau.', 'Words cost nothing; choose them with care for one another.', TRUE, TRUE),
('proverb_10', 'proverb', E'Anh em như thể tay chân,\nRách lành đùm bọc, dở hay đỡ đần.', 'Family stays close and lends a hand through good times and hard times.', TRUE, TRUE),
('proverb_11', 'proverb', 'Đi một ngày đàng, học một sàng khôn.', 'Every journey brings something new to learn.', TRUE, TRUE),
('proverb_12', 'proverb', 'Góp gió thành bão.', 'Small efforts gathered together can become something great.', TRUE, TRUE),
('proverb_13', 'proverb', 'Tích tiểu thành đại.', 'Many small things can add up to something great.', TRUE, TRUE),
('proverb_14', 'proverb', 'Chị ngã em nâng.', 'When one sibling stumbles, another helps them up.', TRUE, TRUE),
('proverb_15', 'proverb', 'Bán anh em xa, mua láng giềng gần.', 'Treasure the neighbors who are close enough to lend a hand.', TRUE, TRUE),
('proverb_16', 'proverb', 'Một con ngựa đau, cả tàu bỏ cỏ.', 'When one is hurting, the whole family feels concern.', TRUE, TRUE),
('proverb_17', 'proverb', 'Thương người như thể thương thân.', 'Care for others as you care for yourself.', TRUE, TRUE),
('proverb_18', 'proverb', 'Đói cho sạch, rách cho thơm.', 'Keep your dignity and kindness, even in difficult times.', TRUE, TRUE),
('proverb_19', 'proverb', 'Ở hiền gặp lành.', 'May kindness find kindness in return.', TRUE, TRUE),
('proverb_20', 'proverb', 'Kiến tha lâu cũng đầy tổ.', 'Little by little, steady effort fills the nest.', TRUE, TRUE),
('tip_draft_01', 'health_tip', 'Để sẵn cuốn sổ và cây bút ở nơi dễ thấy, bạn sẽ tiện ghi lại điều muốn hỏi bác sĩ.', 'Keep a notebook and pen somewhere easy to see, ready to write down questions for your doctor.', FALSE, FALSE),
('tip_draft_02', 'health_tip', 'Trước buổi tư vấn, bạn có thể ghi ngắn gọn điều đang làm mình băn khoăn.', 'Before a consultation, jot down the main thing you would like to discuss.', FALSE, FALSE),
('tip_draft_03', 'health_tip', 'Khi ghi lại một chỉ số, nhớ ghi cả thời điểm đo để tiện xem lại.', 'When recording a measurement, include the time so it is easier to review later.', FALSE, FALSE),
('tip_draft_04', 'health_tip', 'Để giấy tờ khám bệnh cùng một chỗ sẽ giúp bạn tìm lại dễ hơn khi cần.', 'Keeping your medical papers together makes them easier to find when needed.', FALSE, FALSE),
('tip_draft_05', 'health_tip', 'Bạn có thể nhờ người thân cùng ghi lại những điều cần hỏi trong lần tư vấn tiếp theo.', 'A family member can help you write down questions for your next consultation.', FALSE, FALSE),
('tip_draft_06', 'health_tip', 'Nếu chưa nghe rõ câu hỏi, bạn cứ bấm nghe lại rồi trả lời theo điều mình nhớ.', 'If you did not hear a question clearly, play it again before answering.', FALSE, FALSE),
('tip_draft_07', 'health_tip', 'Khi không nhớ rõ một thông tin, bạn cứ nói chưa rõ để bác sĩ hỏi thêm.', 'If you do not remember something clearly, let your doctor know.', FALSE, FALSE),
('tip_draft_08', 'health_tip', 'Trước khi gửi ghi âm, bạn có thể nghe lại để chắc rằng lời nhắn đã rõ.', 'You can listen to a recording before sending it to check that your message is clear.', FALSE, FALSE),
('tip_draft_09', 'health_tip', 'Ghi tên và ngày của mỗi lần khám sẽ giúp bạn sắp xếp hồ sơ dễ hơn.', 'Labeling each visit with its name and date helps keep your records organized.', FALSE, FALSE),
('tip_draft_10', 'health_tip', 'Bạn có thể lưu câu hỏi vừa nghĩ ra vào sổ, để lần tư vấn tới không quên.', 'Write down a question when it comes to mind so you remember it at your next consultation.', FALSE, FALSE),
('tip_draft_11', 'health_tip', 'Khi trao đổi với bác sĩ, bạn cứ dùng từ quen thuộc để kể điều mình đang cảm thấy.', 'Use your own everyday words to describe how you feel when talking with your doctor.', FALSE, FALSE),
('tip_draft_12', 'health_tip', 'Nếu hướng dẫn nào chưa rõ, bạn có thể nhờ bác sĩ giải thích lại bằng cách dễ hiểu hơn.', 'If an instruction is unclear, ask your doctor to explain it in simpler words.', FALSE, FALSE)
ON CONFLICT (code) DO NOTHING;
