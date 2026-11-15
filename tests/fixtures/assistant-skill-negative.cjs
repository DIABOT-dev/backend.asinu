'use strict';
module.exports = [
  ['negative.other-person','journal','Mẹ tôi vừa uống 200 ml nước'],
  ['negative.bp','journal','Ghi huyết áp 12/8'],
  ['negative.dosage','medication','Nhắc tôi uống Hapacol 2 viên mỗi ngày lúc 7 giờ sáng'],
  ['negative.mixed-delete','journal','Ghi 200 ml nước và xóa tài khoản'],
  ['negative.topup','billing','Nạp tiền vào ví giúp tôi'],
  ['negative.gift','gifts','Mở hộp lộc giúp tôi'],
].map(([id,skill,text])=>({id,skill,text,actions:[],expectNoActions:true}));
