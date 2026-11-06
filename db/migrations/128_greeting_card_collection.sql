-- The product owner explicitly delegated creating/activating these nonmedical
-- greeting cards in the 06/11/2026 conversation. This is not clinical/P6 sign-off.
-- Preserve any card that was already approved or customized by an editor.
INSERT INTO greeting_templates(code,title,title_en,body,body_en,active,approved_by,approved_at) VALUES
 ('MISS_YOU','Nhớ người thân','Thinking of you',
  'Gửi bạn một chút ấm áp trong ngày. Mong chúng ta sớm có dịp ngồi bên nhau, kể những chuyện thật bình thường.',
  'Sending a little warmth your way. I hope we can sit together soon and share the little things in our days.',
  TRUE,'product-owner-delegated-20261106',NOW()),
 ('BIRTHDAY','Mừng sinh nhật','Happy birthday',
  'Chúc bạn một tuổi mới bình an, nhiều sức khỏe và niềm vui. Mong mỗi ngày đều có điều nhỏ bé khiến bạn mỉm cười.',
  'Wishing you a peaceful new year of life, good health and joy. May each day bring a little reason to smile.',
  TRUE,'product-owner-delegated-20261106',NOW()),
 ('NEW_YEAR','Năm mới bình an','A peaceful new year',
  'Chúc năm mới bình an, sum vầy và đầy yêu thương. Mong cả nhà luôn mạnh khỏe và có thêm nhiều ngày được ở bên nhau.',
  'Wishing our family a peaceful new year, filled with warmth and love. May we stay well and share more days together.',
  TRUE,'product-owner-delegated-20261106',NOW())
ON CONFLICT(code) DO UPDATE SET title=EXCLUDED.title,title_en=EXCLUDED.title_en,
 body=EXCLUDED.body,body_en=EXCLUDED.body_en,active=EXCLUDED.active,
 approved_by=EXCLUDED.approved_by,approved_at=EXCLUDED.approved_at
WHERE greeting_templates.active=FALSE AND greeting_templates.approved_at IS NULL;
