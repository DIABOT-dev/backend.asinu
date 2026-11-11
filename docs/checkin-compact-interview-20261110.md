# Check-in gọn theo tám nhóm, bản local chờ người dùng duyệt

Làm trên `change/check-in`. Sau đợt kiểm thử, người dùng đã yêu cầu commit và push riêng từng phần; không merge vào `main` hoặc deploy trong đợt này.

## Luồng

1. Triệu chứng chính.
2. Dấu hiệu nguy hiểm.
3. Ảnh hưởng sinh hoạt, dùng làm đánh giá mức độ; không hỏi lại một thang mức độ khác.
4. Thời gian bắt đầu và diễn biến, hai câu rõ ràng.
5. Chi tiết còn thiếu có ích về vị trí, tính chất, cách xuất hiện hoặc yếu tố liên quan. Dùng lại vị trí đã chọn; thời lượng mỗi cơn chỉ hỏi khi thực sự xảy ra từng cơn.
6. Thuốc và chỉ số hôm nay, khi hồ sơ có bệnh nền.
7. Sự việc trước lúc khó chịu: thay đổi bệnh nền/chỉ số, thuốc, ăn uống, vận động/chấn thương, sinh hoạt/môi trường, biểu hiện bệnh mới.
8. Thay đổi kèm theo chưa kể.

Tám nhóm là khung thông tin, không phải giới hạn tám hoặc chín câu. Phiên mới theo dõi dữ kiện riêng từng triệu chứng; tái sử dụng thông tin đã có trong bất kỳ câu trả lời nào. Các câu cùng trục có thể hỏi chung những triệu chứng đang thiếu, có lựa chọn “Mỗi triệu chứng khác nhau”; khi chọn khác nhau mới hỏi riêng phần đó. Không chạy lại cả bộ theo từng vùng. Dấu hiệu nguy hiểm được xử lý ngay, không chờ đủ câu. Các phiên compact v1 đã bắt đầu giữ kế hoạch cũ; phiên mới dùng compact v2 trong assessment_version=3.

Dr7 tạo câu hỏi và nhãn lựa chọn; lượt duyệt riêng kiểm tra độ rõ ràng, tương ứng câu hỏi/đáp án và sự trùng lặp. Server giữ nhóm bắt buộc, mã đáp án cho các thang đánh giá, khoảng thời gian không chồng lấn, và nhãn cảnh báo của bộ sàng lọc hiện có. Không chuyển sang nhà cung cấp AI khác khi Dr7 lỗi. Khi lỗi: câu hỏi dự phòng + ô nhập/nói, có `questionSource=fallback`; không giả là lựa chọn do AI tạo.

Model sinh ưu tiên `CHECKIN_COMPACT_QUESTION_MODEL`, rồi cấu hình câu hỏi chung `CHECKIN_QUESTION_MODEL`; mặc định `medgemma-27b-it` trên Dr7. Model duyệt dùng `CHECKIN_QUESTION_REVIEW_MODEL`, mặc định cùng model 27b. Câu trả lời tránh xưng hô để không nhầm người bệnh với Asinu. Nhóm thuốc có lựa chọn không có thuốc được kê; bệnh nền không tự chứng minh đang dùng thuốc.

Kiểm tra xưng hô dùng cùng hàm hồ sơ: 56 tuổi nam là chú/cháu, nữ là cô/cháu; 60–74 tuổi là bác/cháu; từ 75 tuổi dùng ông hoặc bà/cháu nếu biết giới tính. Không đủ thông tin thì không tự đoán giới tính. Tên được gọi ở bước mở đầu hiện có, không nhắc lại ở mỗi câu. Câu hỏi ngắn, trực tiếp và lễ phép; tránh lặp “cho cháu hỏi”, “có thể cho cháu biết”. Lời phản hồi không hứa theo dõi liên tục và không trấn an chắc chắn khi chưa đánh giá xong.

Đáp án phải cùng chủ đề với câu hỏi. Triệu chứng chính có ít nhất năm lựa chọn thực tế, tham khảo các biểu hiện phù hợp với vị trí đã chọn, tối đa tám lựa chọn AI cho nhóm mở. Nhóm tính chất/vị trí cho chọn nhiều khi cảm giác hỗn hợp hoặc hai bên cùng khó chịu. Các thang thời gian/diễn biến/ảnh hưởng sinh hoạt giữ một trục rõ ràng; không trộn đã thử cách gì với thử rồi có đỡ không. Lượt duyệt từ chối thiếu lựa chọn thường gặp thay vì đẩy hết sang Không rõ/Khác. Không tuyên bố một danh sách hữu hạn bao quát mọi tình huống lâm sàng: ô gõ/nói luôn sẵn.

Mỗi câu có các đáp án bấm chọn, cùng **một ô nhập hoặc nói**. Nội dung tự nhập là câu trả lời của câu đang hỏi; không tự tách thành “Khó chịu khác” và không mở thêm một bộ câu hỏi. `Không rõ` được ghi nhận một lần. Nội dung lựa chọn `Khác` phải được thay bằng lời người dùng trước khi gửi.

## Lưu và tương thích

- FE mới gửi `assessment_version=3`. Server bật mới qua `CHECKIN_COMPACT_INTERVIEW_ENABLED` (mặc định chỉ bật ở development/test).
- Phiên đã bắt đầu giữ phiên bản đang dùng, kể cả khi cập nhật app hoặc tắt cờ. Không chuyển phiên đang trả lời sang bộ câu hỏi khác.
- Câu đã sinh, thứ tự và lựa chọn lưu trong phần trạng thái mã hóa hiện có. Mở lại trả đúng câu cũ, không gọi AI lại. Không có bảng hay migration mới.
- Giữ kiểm tra quyền sở hữu, `phase_id`, tiền tố câu trả lời và CAS để chặn ghi đè từ máy khác.
- Câu trả lời của tám nhóm đi vào dữ kiện kết luận. Nhóm nguồn gốc chỉ là sự việc/nghi ngờ, không phải nguyên nhân được xác nhận. Bản ghi thuốc trống không đồng nghĩa quên uống.
- Luồng hỏi lại theo dõi sau kết luận và các phiên cũ vẫn dùng cơ chế hiện có.

## Kiểm thử local với tài khoản thử

1. Bắt đầu phiên mới; chọn Tay chân và nhập mô tả sưng khớp như ảnh báo lỗi. Không xuất hiện “Khó chịu khác / Vùng 2/2”; thời gian, diễn biến và sinh hoạt chỉ hỏi một lần.
2. Chọn nhiều vùng; hoàn thành chung tám nhóm. Gõ thời gian khác nhau cho mỗi vùng; kết luận giữ đúng lời khai.
3. Hồ sơ có tiểu đường/tăng huyết áp: có câu thuốc/chỉ số; câu nguồn gốc có đủ sáu hướng và ô nói/gõ.
4. Ở mỗi câu, thử một đáp án bấm chọn; ở phiên khác, gõ hoặc nói câu không có trong đáp án. Không tự mở thêm vùng/phỏng vấn.
5. Thoát và vào lại giữa chừng; câu hỏi/lựa chọn và câu đã trả lời giữ nguyên. Bấm nhanh nhiều lần không sinh thêm câu.
6. Chọn Không rõ ở nguồn gốc: không hỏi lặp, không kết luận nguyên nhân chắc chắn. Chọn dấu hiệu nguy hiểm: xử lý ngay.
7. Mất mạng/Dr7 lỗi: còn câu đã lưu, có thể thử lại; dự phòng cho phép nhập/nói. Huỷ phiên không còn nút tiếp tục cho phiên bị huỷ.
8. Xem kết luận và nghe lại: có dữ kiện nguồn gốc, không bịa chỉ số/tuân thủ thuốc; giữ luồng đọc đầy đủ hiện có.

Các kiểm thử máy: `tests/unit/checkin-compact-interview.test.js`, `tests/checkin-api.integration.test.js`; FE: `scripts/check-checkin-practice.mjs`, `scripts/check-checkin-api-contract.mjs`, các kiểm thử dictation/progress/viewport hiện có.

## Căn cứ giữ sàng lọc nguy hiểm

Không giảm cảnh báo chỉ để đạt số câu. Tham khảo [NHS về khớp sưng đau và nhiễm trùng khớp](https://www.nhs.uk/conditions/septic-arthritis/) và [NIDDK về các yếu tố liên quan hạ đường huyết](https://www.niddk.nih.gov/health-information/diabetes/overview/preventing-problems/low-blood-glucose-hypoglycemia). Những nguồn này hỗ trợ việc giữ sàng lọc an toàn; không xác nhận bộ tám nhóm là một công cụ chẩn đoán đã được thẩm định.

## Rà soát câu hỏi và đáp án, 11/11/2026

Đã tái hiện lỗi bằng kiểm thử trước khi sửa, sau đó kiểm tra lại cả câu hỏi sinh từ Dr7 và giao diện gửi câu trả lời.

| Vấn đề tìm được | Xử lý |
| --- | --- |
| “Mỗi cơn kéo dài 5 phút”, “sau ăn 30 phút” bị coi là thời điểm bắt đầu | Chỉ bỏ câu thời gian khi có lời khai rõ về lúc bắt đầu. Không lấy thời lượng mỗi cơn, khoảng cách sau bữa ăn hoặc mốc bị phủ định làm thời điểm khởi phát. |
| Mã đáp án và nhãn AI có thể ngược nghĩa | Kiểm tra tương ứng của các thang diễn biến, ảnh hưởng sinh hoạt, khoảng thời gian, thuốc và đo chỉ số trước khi hiển thị. Giữ các nhãn AI có nghĩa đúng; không thay bằng một bộ đáp án viết sẵn. |
| Chóng mặt bị hỏi thời lượng hoặc giờ xuất hiện ở nhóm tính chất | Bổ sung yêu cầu phân biệt cảm giác và phản hồi lỗi đúng nhóm khi sinh lại. Không hỏi lại thời gian ở nhóm này. |
| “Không có đơn thuốc/tự dừng” gộp hai tình huống khác nhau | Tách ý nghĩa không có thuốc được kê với quên, sai giờ hoặc thay đổi thuốc. Nhãn mâu thuẫn bị từ chối. |
| Đáp án chứa lời Asinu hứa hỏi chỉ số sau, nhưng không có bước đó | Loại phần chú thích trong ngoặc tách rời, giữ nguyên sự việc “Đã đo…”. Các câu Asinu nói lẫn vào đáp án còn lại bị từ chối. Giá trị và giờ đo có thể nhập ngay trong ô hiện có. |
| “Không có/Khác” do AI sinh trùng với lựa chọn của app; “Không rõ” còn lặp ở cuối màn hình | Lọc cả mã và cách diễn đạt của lựa chọn thoát do AI sinh. FE chỉ hiện nút bỏ qua riêng khi danh sách chưa có đáp án đó. |
| “Ở tinh thần” nghe như một vị trí cơ thể | Chặn cách nói này và yêu cầu câu hỏi tự nhiên về cảm xúc hoặc giấc ngủ. |
| Nguồn gốc với ngứa da thiếu ví dụ tiếp xúc thường gặp | Cho AI cá nhân hoá nhóm sinh hoạt/môi trường bằng tiếp xúc xà phòng, mỹ phẩm hoặc chất tẩy rửa mới. Vẫn giữ sáu hướng sàng lọc. |
| Câu tiếng Anh bị ảnh hưởng bởi ví dụ tiếng Việt trong prompt | Gửi yêu cầu ngôn ngữ đầu ra rõ ràng cho cả bước sinh và duyệt; đã thử lại câu triệu chứng bằng Dr7 thật. |

Xưng hô vẫn lấy từ tuổi/giới tính hồ sơ, không hard-code “bạn” cho mọi người. Một lời mở đầu rời như “Bác cho cháu hỏi, …” có thể bỏ nếu phía sau đã là câu hỏi hoàn chỉnh. Không biến một câu thiếu thành phần thành câu hỏi mới bằng cách cắt chuỗi.

Các mẫu thử Dr7 dùng hồ sơ giả: bụng đầy hơi nhưng không đau; ngứa da ở nữ 56 tuổi; chóng mặt ở người 66 tuổi có bệnh nền; nhiều vùng với thời gian khác nhau; khó ngủ ở nam 78 tuổi; hồi hộp ở nữ 35 tuổi; mệt toàn thân ở nam 56 tuổi; câu triệu chứng tiếng Anh. Trong một đợt, Dr7 trả HTTP 429 nên các câu còn lại đi qua dự phòng. Các câu trọng tâm đã được thử lại riêng sau sửa; không tính các câu dự phòng là đã kiểm tra thành công với AI. Khi Dr7 lỗi hoặc câu không qua kiểm tra, vẫn giữ câu dự phòng và ô gõ/nói, không đổi nhà cung cấp.

Đối chiếu mô tả cảm giác chóng mặt với [NHS về dizziness](https://www.nhs.uk/symptoms/dizziness/) và ví dụ tiếp xúc da với [NHS về nguyên nhân viêm da tiếp xúc](https://www.nhs.uk/conditions/contact-dermatitis/causes/). Đây là căn cứ chọn cách hỏi về biểu hiện/sự việc, không phải gán nguyên nhân bệnh cho người dùng.

Kiểm thử bao gồm: bộ backend Jest, HTTP với PostgreSQL local và tài khoản thử có dọn dẹp, luồng FE chọn nhiều/loại trừ/nhập hoặc nói/tiếp tục phiên, TypeScript và kiểm tra định dạng diff. Không sửa lịch sử của tài khoản người dùng. Việc commit/push trên nhánh được thực hiện sau khi người dùng yêu cầu; đợt này không deploy.


## Tối ưu nhiều triệu chứng và bệnh nền, compact v2

- Mỗi triệu chứng có ID nội bộ, lời khai và bằng chứng trích nguyên văn. Thời điểm, diễn biến và chi tiết của hai triệu chứng được giữ riêng. Phần thay đổi cùng nhau chỉ gán cho các triệu chứng có trong câu hỏi.
- Dr7 trích xuất dữ kiện từ lời nói/gõ; một lượt duyệt độc lập kiểm tra bằng chứng và chủ sở hữu. Giá trị AI diễn đạt lại được thay bằng trích dẫn thật trước khi duyệt. Lượt duyệt trả lời ngắn để tránh lỗi JSON bị cắt khi model chép lại cả hồ sơ.
- Câu bấm chọn rõ ràng cập nhật trực tiếp dữ kiện theo phạm vi đã hỏi, không cần thêm một lượt AI để hiểu lại cùng đáp án. Dữ kiện đã xử lý được lưu mã hoá cùng câu hỏi; mở lại/retry không sinh lại hoặc phân tích lại.
- Có thể hỏi chung thời gian, diễn biến, cách xuất hiện, yếu tố làm tăng hoặc cách đã thử nếu cùng thuộc một trục. “Khác nhau” là lựa chọn loại trừ; nhập/nói riêng sẽ thay lựa chọn này bằng lời thật. Khi cần tách thì chỉ hỏi phần thiếu cho đúng triệu chứng.
- “Không rõ” và trả lời chưa đúng ý được giữ là thiếu/chưa rõ, không tự biến thành bình thường và không lặp câu đó vô hạn. Thông tin mâu thuẫn được hỏi xác nhận bằng hai lời khai; thông tin bổ sung tương thích chỉ làm rõ dữ kiện cũ.
- Những dấu hiệu nguy hiểm đã có trong bộ hiện hành được gộp và chia nhóm tối đa sáu mục, không cắt mất các mục sau sáu. Mỗi nhóm chỉ hỏi một lần; tiêu đề ghi rõ phần. Chọn dấu hiệu cảnh báo thì xử lý ngay. Đây là phạm vi của bộ cảnh báo hiện có và lớp phân loại Dr7, không phải tuyên bố bao phủ mọi bệnh.
- Hỏi thuốc hôm nay một lần. Huyết áp và đường huyết là hai phạm vi độc lập: chưa đo loại này không chứng minh chưa đo loại kia; bản ghi huyết áp không thay được đường huyết. Dùng lại bản ghi hợp lệ hôm nay theo giờ Việt Nam, chỉ hỏi trạng thái/giá trị còn thiếu. Câu nhập chỉ số có lời nhắc đúng mục đích và không có giá trị mẫu do AI bịa để bấm chọn.
- Triệu chứng khai thêm giữa chừng được bổ sung phần cần thiết và các cảnh báo mới; các câu chung đã trả lời không mở lại. Mức cần chú ý không bị giảm vì một triệu chứng đỡ trong khi triệu chứng khác nặng hơn.
- Dữ kiện `concerns`, `global`, `measurements`, `missing` đi vào kết luận; các mốc khác nhau được giữ nguyên. Lịch sử/giá trị chưa chốt không được coi là đồng thời đúng ở hiện tại.
- FE hiển thị số câu thực tế khi chưa biết tổng, không dùng mẫu số 8/9 hoặc phần trăm cố định cho phiên nhiều triệu chứng. Hướng dẫn vẫn là minh hoạ, không thực hiện hay lưu nghiệp vụ check-in.
- Câu hỏi thời điểm dùng chủ ngữ đầy đủ như “Tình trạng … của chú bắt đầu từ khi nào vậy?”, không ghép danh sách triệu chứng trần vào câu. Danh sách dài dùng “Những khó chịu này” để câu ngắn và dễ nghe.
- Với câu có lựa chọn “Khác”, ô gõ/nói chỉ hiện sau khi chọn mục này, nằm dưới đáp án. Bỏ chọn “Khác”, chọn đáp án loại trừ hoặc sang câu mới sẽ xoá nội dung nhập; nhiều đáp án thông thường vẫn kết hợp được với phần kể thêm. Hướng dẫn trỏ vào “Khác” trước, sau đó mới hướng dẫn giọng nói.
- Nếu Dr7 lỗi hoặc câu chỉ số bị từ chối, câu trạng thái thuốc/chỉ số vẫn có các lựa chọn tương ứng theo mã hiện hành, gồm “Đã đo / Chưa đo” cho đúng loại chỉ số. Nguồn vẫn ghi `fallback`, không giả là AI. Câu dự phòng đang chờ trả lời mà thiếu lựa chọn được bổ sung khi mở lại, giữ nguyên câu chữ, step và lịch sử.
- Mục tiêu kết luận là 2.000–4.000 ký tự theo điều chỉnh của người dùng, có tối đa một lượt viết gọn khi vượt. Sau lượt này, nội dung đầy đủ đã qua mọi kiểm tra an toàn được giữ lại dù còn vượt mục tiêu; không thay toàn bộ bằng đoạn ngắn chỉ vì số ký tự và không cắt cảnh báo. Deadline, kiểm tra dữ kiện và từ chối nội dung không an toàn giữ nguyên. Lời dự phòng phân biệt “thông tin chưa rõ” với việc chưa hỏi.
- Lời trả lời lạc ý hoặc chưa xử lý được (`unresolved`) được hỏi làm rõ theo đúng mục còn thiếu, có câu trả lời trước trong ngữ cảnh và không lặp nguyên câu cũ. Chọn “Không rõ”, thực sự không nhớ hay chưa đo là giới hạn được ghi nhận, không buộc đoán. Số đo thiếu đơn vị được hỏi bổ sung và giữ bằng chứng từng phần; phần đã rõ không mở lại. Báo cáo triệu chứng chưa hiểu được có lượt xác nhận riêng, không kết luận chỉ vì đã đi hết danh sách nhóm.

Không thêm bảng hoặc migration. Không sửa máy trạng thái cuộc gọi, nhắc thuốc, xu/quà hay dữ liệu tài khoản người dùng. Giữ kiểm tra owner/phase/CAS và giới hạn kích thước request hiện có. Commit/push theo từng phần trên `change/check-in`, không merge vào `main` hoặc deploy trong đợt này.

Kiểm thử bổ sung: `tests/unit/checkin-compact-coverage.test.js` và HTTP thực với PostgreSQL local, gồm nhiều triệu chứng vượt chín câu, hai thời gian khác nhau, dữ kiện khai sớm, khai thêm giữa chừng, unknown ở các nhóm cảnh báo, xác nhận mâu thuẫn, tiếp tục phiên, thuốc/chỉ số từng loại, dữ liệu AI không có bằng chứng và Dr7 không sẵn sàng. Các lượt Dr7 thật dùng tài khoản giả trong transaction rollback; báo cáo ở `/tmp/asinu-coverage-*.json`.
