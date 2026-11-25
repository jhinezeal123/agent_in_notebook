# Easy-read — nghiên cứu và thiết kế

Trạng thái **ER‑0 đến ER‑5 đã có code** trên nhánh `feat/easy-read`. F.1 ghi các khác biệt so với thiết kế và F.3 liệt kê các luồng cần xác nhận với VS Code, ACP và Kaggle thật. Tài liệu này nối tiếp `docs/architecture.md` (§ Mentor) và `docs/mentor-dot-3-4.md` (tủ paper, xưởng reproduce).

Nghiên cứu đầy đủ kèm nguồn: [`docs/easy-read-nghien-cuu.md`](easy-read-nghien-cuu.md).

---

## A. Tóm tắt một trang

**Bạn nhận được gì.** Dán link arXiv hoặc chọn PDF → một tab đọc paper trong VS Code (bài báo với công thức, hình, mục lục có tiến độ) và một **gia sư của riêng paper đó** ở khung chat bên phải. Việc đọc đi theo **bốn lượt**, mỗi lượt kết thúc bằng một việc bạn tự làm ra:

| Lượt | Dựa trên | Bạn làm | Easy-read giúp |
|---|---|---|---|
| ① Định hướng (10–15') | Keshav lượt 1, hỏi trước (pretesting) | đoán trước 3 câu, lướt đúng chỗ, tự viết **5C**, quyết định đọc tiếp | tô sáng chỗ cần lướt, chấm 5C, kiến thức nền còn thiếu, bảng ký hiệu |
| ② Hiểu (theo mục) | Keshav lượt 2, nhớ lại chủ động, tự giải thích, Carey (đọc hình), QALMRI | câu dẫn trước mỗi mục; gập mục và **nhớ lại**; tự giải thích chỗ then chốt; trắc nghiệm hai tầng có độ chắc chắn; đọc hình | ký hiệu khi rê chuột, chọn chữ để hỏi, **ví dụ tương tác** cạnh công thức, giải thích trỏ đúng câu trong paper |
| ③ Đào sâu | Keshav lượt 3, Ng (dẫn lại toán), Eisner, Mitzenmacher | dẫn lại công thức (mẫu mờ dần), **câu tự luận** phân tích/đánh giá/sáng tạo, tìm chỗ sai, ghi chú phản biện, review một trang, dựng lại sườn paper từ trí nhớ | chấm theo rubric có tham chiếu, "đồng nghiệp" AI đáp ghi chú lề |
| ④ Ghi nhớ | Nielsen, Matuschak, Quantum Country, Feynman | giải thích cho người khác, duyệt/viết **thẻ ôn**, ghi chú 5 câu | ôn ngắt quãng ở thẻ Khởi động của Mentor; Sổ lỗi sai; nút **Reproduce** sang xưởng Mentor |

**Bốn nguyên tắc** (cùng tinh thần với Mentor):

1. **AI không đọc hộ.** Bạn làm phần *nghĩ*: đoán, nhớ lại, giải thích, phản biện. AI chuẩn bị, hỏi, phản hồi, và giải thích ngay khi bạn hỏi. Thứ duy nhất bị giữ lại là đáp án của việc đang chờ bạn làm.
2. **Mọi điều AI nói về paper trỏ về đúng chỗ trong paper**, bấm được, và câu trích được máy so với paper thật trước khi tới tay bạn.
3. **Luật do máy giữ, không chỉ do prompt**: thứ tự các bước, đáp án bị ẩn, câu hỏi phải qua kiểm.
4. **Mỗi buổi ≤ 40 phút.** Thanh đọc đếm ngược theo đồng hồ của buổi; mốc bắt đầu và kết thúc còn khi mở lại tab. Khi hết giờ, bấm **Bắt đầu buổi mới** để tiếp tục nộp checkpoint. Tiến độ và lịch ôn lấy từ nhật ký.

**Đội agent**: *gia sư* (chat với bạn) · *người soạn* (chạy nền, soạn trước một bước so với bạn: bản đồ paper, câu hỏi, widget) · *người kiểm* (giải mù từng câu trắc nghiệm, không thấy đáp án) · *đồng nghiệp lề* (phản biện ở lượt 3). Tất cả chạy trên agent ACP bạn đang dùng. Mặc định agent nền **không tự chạy**: mỗi việc của người soạn (kèm người kiểm) chờ bạn bấm **Soạn**, và mỗi paper có thể bị khóa agent, xem E.4.5.

Bảy quyết định triển khai đã chốt ở G.3.

---

## B. Nghiên cứu cho thấy gì (tóm tắt)

1. **Các phương pháp đọc paper thống nhất ở cấu trúc nhiều lượt**, mỗi lượt một mục tiêu và một điều kiện xong rõ ràng: Keshav (5C → tóm được ý chính kèm chứng cứ → dựng lại paper từ trí nhớ), Ng (các lượt từ hình tới toán; dẫn lại toán, cài lại code), Griswold ("chưa trả lời hết 8 câu thì chưa đọc xong"), Carey et al. (sáu câu hỏi cho cả bài và cho từng hình). Đây là lời khuyên của người làm nghề, không phải kết quả thí nghiệm, nhưng cơ chế bên dưới (tự sinh, nhớ lại, tự giải thích) có bằng chứng.
2. **Thứ giúp nhớ lâu là tự kiểm tra và ôn giãn cách** (Dunlosky: hữu ích cao), không phải đọc lại, tô sáng hay tóm tắt (hữu ích thấp). Đọc lại còn làm *tưởng* mình nhớ: sau 1 tuần, học lại 40 % so với kiểm tra lặp 61 % (Roediger & Karpicke). Hỏi trước khi đọc giúp cả khi trả lời sai, nếu sau đó thấy đáp án (Pan & Carpenter).
3. **Bước nhảy lớn nhất là từ "chủ động" sang "kiến tạo"** (ICAP): chọn đáp án trắc nghiệm chỉ là chủ động; giải thích, dự đoán, so sánh, thiết kế mới là kiến tạo. Tự giải thích được nhắc cho hiệu ứng lớn (d = 1,14, Chi). Vì vậy trắc nghiệm đứng *sau* phần nhớ lại và tự giải thích, không thay chúng.
4. **Gia sư AI có hiệu quả khi được ép cấu trúc, có hại khi không**: RCT ở Harvard 0,73–1,3 SD khi nền tảng ép trình tự từng bước (Kestin et al.); GPT-4 không rào chắn làm giảm kỹ năng tự làm (Bastani et al.). Các "study mode" hiện có chỉ là prompt và tự nhận không nhất quán.
5. **Câu hỏi do LLM sinh dùng được nhưng có lỗi hệ thống**: nhiều đáp án đúng 4,9 % (gấp 4 lần người), chỉ ~66 % đúng mức Bloom yêu cầu, phương án nhiễu lộ đáp án; **bộ kiểm theo luật bắt lỗi viết câu tốt hơn chính GPT-4**. LLM chấm tự luận chỉ ở mức QWK ~0,68, tốt hơn nhiều khi có đáp án tham chiếu và rubric.
6. **Giải thích tương tác có hiệu quả khi gắn vào lời giải thích, dùng một ví dụ đồ chơi xuyên suốt và cho đoán trước khi xem** (Victor, Alammar, Transformer Explainer, Mayer); "giải thích chạy được" thắng chat (Explorable Proofs). Nhưng tương tác không dùng đến chỉ tốn công (Hohman et al.).
7. **Khoảng trống của các công cụ hiện có** (alphaXiv, NotebookLM, SciSpace, ChatPDF, các study mode): dừng ở tóm tắt + chat + flashcard mức nhớ. Không công cụ nào có cùng lúc: ký hiệu tại chỗ (ScholarPhi được người dùng rất thích nhưng chưa sản phẩm nào làm), ví dụ chạy được gắn với từng công thức, câu hỏi neo vào đúng claim và chấm tự luận theo chứng cứ, ôn ngắt quãng.

---

## C. Nguyên tắc → tính năng

| Kỹ thuật | Tính năng trong easy-read | Mức bằng chứng |
|---|---|---|
| Đọc nhiều lượt có điều kiện xong (Keshav, Ng, Griswold) | 4 lượt, mỗi lượt một việc bạn làm ra (5C · tóm tắt có chứng cứ · dựng lại sườn · thẻ ôn) | lời khuyên nghề nghiệp |
| Hỏi trước (pretesting) | 3 câu đoán ở lượt 1; câu dẫn trước mỗi mục; đáp án mở sau khi đọc | trung bình |
| Dạy trước thuật ngữ (Mayer *pretraining*) | bảng ký hiệu và thuật ngữ cuối lượt 1; ký hiệu khi rê chuột | trung bình (d = 0,85) |
| Nhớ lại chủ động, lặp tới khi đúng | gập mục rồi viết; câu sai quay lại tới khi đúng; "Hỏi tôi một câu" | **mạnh** |
| Tự giải thích, hỏi "vì sao" | tự giải thích chỗ then chốt; gia sư phân biệt diễn đạt lại và giải thích | trung bình – mạnh |
| ICAP: kiến tạo hơn chủ động | mặc định là viết/đoán/giải thích; trắc nghiệm đứng sau; gia sư xây trên câu trả lời của bạn | trung bình – mạnh |
| Đoán trước khi xem | che kết quả bảng; widget hỏi đoán trước khi mở | trung bình |
| Đọc hình theo câu hỏi (Carey) | thẻ Đọc hình, bạn tự viết thông điệp của hình | lời khuyên nghề nghiệp |
| Ví dụ mẫu mờ dần từ bước cuối | dẫn lại công thức ở lượt 3 | trung bình – mạnh |
| Giải thích tương tác (Victor, Mayer, Alammar) | widget cạnh công thức, ví dụ đồ chơi xuyên suốt, "Thử điều này", tự kiểm | mạnh cho nguyên tắc của Mayer; nghề nghiệp cho explorable |
| Đọc phê phán (Mitzenmacher, Eisner, QALMRI) | câu đào sâu, phiếu QALMRI, tìm chỗ sai, review một trang, đồng nghiệp lề | trung bình (agent đồng nghiệp: N = 46) |
| Câu hỏi theo Bloom, viết theo luật | ngân hàng câu gắn mức Bloom, mỗi mục có câu mức cao; bộ kiểm theo luật + giải mù + xếp mức độc lập | khung lý thuyết + kết quả về LLM |
| Hai tầng + độ chắc chắn | trắc nghiệm hai tầng; điểm Gardner-Medwin; "chắc mà sai" vào Sổ lỗi sai | trung bình |
| Ôn giãn cách, xen kẽ | thẻ ôn theo lịch Quantum Country ở thẻ Khởi động, xen kẽ các paper | **mạnh** |
| Viết thẻ tốt (Nielsen, Matuschak) | bạn duyệt/viết thẻ; bridge kiểm luật thẻ | lời khuyên nghề nghiệp + hiệu ứng tự sinh |
| Giải thích cho người khác (Feynman) | lượt 4, gia sư đóng vai người nghe hỏi lại | nghề nghiệp, qua cơ chế tự giải thích |
| Gia sư có rào chắn | bridge giấu đáp án việc đang chờ; thang trợ giúp 0–3 | trung bình (một RCT, một thí nghiệm thực địa) |
| Tránh thứ hữu ích thấp | không đặt tóm tắt tự động, tô sáng hay đọc lại làm đường chính; tô vai trò đoạn chỉ để định hướng khi lướt | **mạnh** (Dunlosky) |

---

## D. Trải nghiệm

### D.1 Mở một paper

1. Lệnh **Easy Read: Mở paper…** (hoặc nút **Đọc** trên thẻ paper trong Tủ paper của Mentor). Dán link/id arXiv, hoặc chọn file PDF. Không cần mở notebook nào.
2. Sau 10–30 giây, tab **Đọc: LoRA** mở ở giữa; khung chat bên phải là **gia sư của paper này** (cuộc trò chuyện đi theo paper, mở lại hôm sau vẫn còn).
3. Gia sư hỏi một câu: **bạn đọc paper này để làm gì?**

| Mục tiêu | Các lượt | Thời gian gợi ý |
|---|---|---|
| **Nắm ý**: biết paper làm gì, có đáng đọc kỹ không | Lượt 1 | 10–15 phút |
| **Hiểu để dùng**: áp dụng vào việc của mình | Lượt 1–2, phần "giả định và hạn chế" của lượt 3, thẻ ôn | 1–2 buổi |
| **Hiểu sâu**: dẫn lại được, phản biện được, có thể reproduce | Đủ 4 lượt, rồi Reproduce (xưởng Mentor) | 3–5 buổi |

4. Trong lúc bạn bắt đầu lượt 1, người soạn (agent chạy nền) làm **bản đồ paper**: vai trò từng đoạn, bảng ký hiệu, khái niệm chính, kiến thức nền, câu hỏi cho các mục. Mất 2–4 phút; phần nào xong thì hiện phần đó.

### D.2 Màn đọc

```
┌ Đọc: LoRA — Low-Rank Adaptation of LLMs (Hu et al., 2021) ─────────────────────────────────────┐
│ ① Định hướng ✓   ② Hiểu ◐ 3/7 mục   ③ Đào sâu ○   ④ Ghi nhớ ○          mục tiêu: Hiểu sâu   ⏱ 24' │
├────────────┬───────────────────────────────────────────────┬─────────────────────────────────────┤
│ Mục lục    │ 4.1 Low-Rank-Parametrized Update Matrices      │ [Ký hiệu] Hình  Hỏi  Ví dụ  Ôn       │
│ 1 Intro ●  │                                                │  W₀  ∈ ℝ^{d×k}  trọng số gốc, đóng   │
│ 2 Problem ●│ ▌For a pre-trained weight matrix W₀ ∈ ℝ^{d×k}, │      băng            [§4.1 ¶1]       │
│ 3 Aren't…◐ │ ▌we constrain its update by representing …    │  B   ∈ ℝ^{d×r}  khởi tạo 0           │
│ 4 Method ◐ │     h = W₀x + ΔWx = W₀x + BAx        (3)  [▶]  │  A   ∈ ℝ^{r×k}  Gaussian ngẫu nhiên  │
│ 5 Exper. ○ │                                                │  r   ≪ min(d,k) rank                 │
│ 6 Related ○│ ┌ chọn chữ ───────────────────────────────┐    │  α   hệ số scale, ΔW·α/r            │
│ 7 Underst.○│ │ Giải thích · Ví dụ cụ thể · Ký hiệu · Vì sao? │                                   │
│            │ └──────────────────────────────────────────┘    │  ▶ Ví dụ: kéo r, xem số tham số    │
│ Hiểu: 64 % │  … ── Checkpoint cuối mục 4.1 (4 câu) ──        │    và sai số xấp xỉ của ΔW           │
└────────────┴───────────────────────────────────────────────┴─────────────────────────────────────┘
```

- Mục lục có chấm tiến độ: ○ chưa đọc · ◐ đã đọc · ● đã qua checkpoint.
- Rê chuột lên một ký hiệu trong công thức → nghĩa của nó (từ bảng ký hiệu), như ScholarPhi.
- Nút **[▶]** cạnh công thức: ví dụ tương tác của công thức đó.
- Bật/tắt **tô vai trò đoạn** (mục tiêu · đóng góp · phương pháp · kết quả · hạn chế), như Scim.

### D.3 Lượt 1 — Định hướng (10–15 phút)

1. **Đoán trước** (2 phút, không tính điểm): 3 câu hỏi về những ý then chốt paper sắp nói, ví dụ "Fine-tune toàn bộ GPT-3 175B tốn ở đâu?", "Theo bạn, nên thêm tham số mới vào đâu để fine-tune rẻ?". Một câu là trắc nghiệm có phương án nhiễu lấy từ các ý khác *trong chính paper*. Trả lời sai vẫn có ích, miễn là sau đó bạn thấy đáp án: mỗi câu tự mở đáp án khi bạn đọc xong mục chứa nó.
2. **Lướt có dẫn đường** (theo Keshav): màn đọc làm mờ những gì lượt 1 không cần; sáng lên: tiêu đề, abstract, phần mở đầu, tiêu đề các mục, hình và bảng chính, kết luận, danh sách tham khảo (lướt, đánh dấu bài bạn đã đọc).
3. **Tự viết 5C** (mỗi ô 1–2 câu, bằng lời của bạn):
   - *Category*: paper thuộc loại gì (phương pháp mới, phân tích, hệ thống, benchmark…)?
   - *Context*: dựa trên những paper/ý tưởng nào?
   - *Correctness*: các giả định có vẻ hợp lý không?
   - *Contributions*: đóng góp chính là gì?
   - *Clarity*: viết có rõ không?
   Gia sư chấm từng ô 0/1/2 so với bản tham chiếu, chỉ chỗ lệch kèm mốc trong paper, rồi mới cho xem bản tham chiếu.
4. **Quyết định**: đọc tiếp hay dừng. Nếu đi tiếp, gia sư liệt kê **kiến thức nền còn thiếu** (ví dụ "rank của ma trận", "fine-tuning vs adapter"); mỗi mục có một giải thích ngắn, trỏ tới một bản trình bày dễ hơn paper gốc khi có (mẹo của Rao: "đừng đọc paper gốc về X trước"), và nếu trùng một sao của bản đồ Mentor thì có nút mở sao đó.
5. **Làm quen ký hiệu và thuật ngữ** (3 phút): bảng các ký hiệu và thuật ngữ chính, mỗi dòng một nghĩa ngắn tiếng Việt. Dạy trước tên gọi giúp lượt sau đỡ quá tải (Mayer: *pretraining*).

### D.4 Lượt 2 — Hiểu (theo từng mục; mỗi buổi ≤ 40 phút)

Với mỗi mục:

1. **Câu hỏi dẫn trước khi đọc**: "Đọc mục này để trả lời: vì sao B được khởi tạo bằng 0?" Một câu, để bạn đọc có mục đích.
2. **Trong khi đọc**: ký hiệu khi rê chuột, chọn chữ để hỏi. Mỗi hình và bảng chính có **Đọc hình** theo sáu câu hỏi của Carey et al. (tác giả muốn biết gì, đã làm gì, vì sao làm thế, kết quả cho thấy gì, tác giả diễn giải ra sao, nên làm gì tiếp), cộng trục, màu, error bar; cuối cùng **bạn tự viết thông điệp chính của hình** trong một câu. Với bảng kết quả: **đoán trước** (các con số bị che, bạn đoán xu hướng, rồi mở và so).
3. **Checkpoint cuối mục** (5–8 phút), theo thứ tự từ khó tới dễ:
   - *Nhớ lại khi gập mục*: mục đang đọc bị che, bạn viết 2–3 câu "mục này nói gì, chứng cứ là gì". Tự nhớ ra (không nhìn) là cách học có bằng chứng mạnh nhất; chọn đáp án có sẵn yếu hơn hẳn.
   - *Tự giải thích một chỗ then chốt*: một dòng công thức hoặc một bước thuật toán, "dòng này làm gì, vì sao cần". Gia sư chấm 0/1/2 và nói rõ khi bạn chỉ *diễn đạt lại* mà chưa *giải thích*; hỏi thêm đúng chỗ còn thiếu.
   - *3–5 câu hỏi* nhắm mục đó: trắc nghiệm 3 phương án, trắc nghiệm **hai tầng** (chọn đáp án, rồi chọn lý do; chỉ tính đúng khi đúng cả hai), dự đoán, ghép ký hiệu ↔ ý nghĩa, xếp các bước, tính một con số. Mỗi câu chọn độ chắc chắn 1–3; điểm theo kiểu Gardner-Medwin (E.8), nên đoán bừa mà chọn "rất chắc" thì thiệt.
   - Sai: lời giải thích trỏ về đúng câu trong paper; phương án bạn chọn cho biết bạn đang hiểu sai điều gì, và điều đó vào **Sổ lỗi sai** (Mentor hỏi lại sau 2 ngày). Câu sai quay lại cuối buổi và hôm sau, tới khi bạn trả lời đúng một lần.
4. **Phần thí nghiệm** dùng **phiếu QALMRI**: câu hỏi · các giả thuyết cạnh tranh · "nếu giả thuyết A đúng thì kết quả phải thế nào" · phương pháp (biến độc lập, phụ thuộc, baseline) · kết quả · kết luận + thí nghiệm bạn sẽ làm tiếp. Bạn điền, gia sư nhận xét. Hợp với ablation của paper ML.
5. **Câu hỏi của tôi**: chỗ nào chưa hiểu thì ghi lại (một phím tắt), đọc tiếp. Cuối lượt, gia sư cùng bạn đi qua danh sách: giải đáp, hoặc đánh dấu "paper không nói" (thường là chỗ đáng nghi nhất của paper).
6. **Xong lượt 2 khi** (Keshav, Griswold): bạn tóm được ý chính của paper kèm chứng cứ cho người khác (≤ 250 chữ, không chép lại abstract), và trả lời được: vấn đề và vì sao cách cũ chưa đủ · lời giải và vì sao nó tốt hơn · bằng chứng · đóng góp · bạn còn thắc mắc gì.

### D.5 Ví dụ tương tác

```
┌ Ví dụ: rank r của LoRA ─────────────────────────────────── trích [§4.1, Eq. 3] ┐
│ Trước khi kéo: theo bạn, r từ 1 lên 64 thì số tham số train của W_q (d=k=12288) │
│ tăng thế nào?   ( ) gần như không đổi  ( ) tuyến tính theo r  ( ) theo r²      │
│                                                         [ Chốt dự đoán ]       │
│ r  ●────────○──────────── 8          d = k = 12288                            │
│ Tham số train: r·(d+k) = 196 608   (0,13 % của d·k)                           │
│ ‖ΔW − B·A‖ / ‖ΔW‖ (ΔW thật có phổ suy giảm nhanh):  ▁▂▃▅▇ ← theo r          │
│ ✓ tự kiểm: r·(d+k) đúng; sai số giảm khi r tăng; r = min(d,k) thì sai số = 0  │
└────────────────────────────────────────────────────────────────────────────────┘
```

- Nằm ngay cạnh công thức nó minh họa, không ở một trang riêng (Victor: ví dụ phải gắn vào lời giải thích, không "thả người đọc vào sandbox"). Mỗi widget có 2–3 việc **"Thử điều này"** do người soạn viết ("kéo r về 1: sai số thế nào?"), và một câu đoán trước khi mở.
- Mặc định tối đa một widget mỗi mục, chỉ cho ý then chốt: tương tác không dùng đến thì chỉ tốn công (Hohman et al.). Gia sư có thể đề xuất thêm trong chat ("Muốn xem bằng ví dụ không?"), hoặc bạn chọn một đoạn và bấm **Ví dụ cụ thể**.
- Kích thước đồ chơi và **một ví dụ chạy suốt paper** (như Illustrated Transformer dùng 4 ô cho 512 chiều và một câu mẫu xuyên suốt): các widget của cùng paper dùng chung một ví dụ khi được.
- Theo Mayer: nhãn nằm ngay cạnh thứ nó gọi tên, không trang trí, bạn tự điều khiển nhịp (từng bước, không tự chạy).
- Mỗi widget nói rõ nó minh họa câu nào trong paper và phần nào là giả lập (số liệu đồ chơi, không phải số của paper).
- Ý cần PyTorch hay dữ liệu thật: nút **Mở thành lab trên notebook** (Kaggle), để khám phá, không chấm.

### D.6 Lượt 3 — Đào sâu

1. **Dẫn lại công thức** quan trọng nhất, mẫu làm sẵn **mờ dần từ bước cuối** (Renkl & Atkinson): lần đầu xem đủ các bước và tự giải thích từng bước; lần hai thiếu bước cuối; lần ba thiếu hai bước cuối; cuối cùng bạn tự dẫn từ đầu. Bạn làm tốt thì mờ nhanh hơn, vấp thì chậm lại.
2. **Câu đào sâu** (5–8 câu, tự luận, chấm theo rubric 0/1/2):
   - *phân tích*: "Giả định ngầm nào làm low-rank update hợp lý? Khi nào nó gãy?"
   - *đánh giá*: "Bảng 2 có đủ để kết luận LoRA ngang full fine-tuning không? Thiếu ablation nào? Có cách giải thích khác cũng hợp lý không?"
   - *so sánh*: "LoRA khác adapter layers ở chỗ nào về độ trễ suy luận? Vì sao?"
   - *ví dụ làm khó tác giả* (Eisner): "Nghĩ một tác vụ mà ΔW khó có rank thấp."
   - *sáng tạo / chuyển giao*: "Bạn sẽ áp LoRA vào mô hình của bạn thế nào? Thiết kế một thí nghiệm kiểm tra chọn r." · "Nếu bắt đầu nghiên cứu từ paper này, việc tiếp theo bạn làm là gì?" (Mitzenmacher)
   Bạn sửa được một lần sau nhận xét, rồi mới xem bài mẫu.
3. **Tìm chỗ sai**: một đoạn tóm tắt paper do người soạn viết, **cố ý cài 2–3 chỗ sai** so với paper (đảo một claim, sai một shape, gán nhầm kết quả). Bạn tìm và chỉ ra câu nào trong paper bác bỏ nó. Đoạn này luôn có nhãn "bài tập — có lỗi cài sẵn". Luyện đúng thói quen mà các công cụ tóm tắt bằng AI làm mất: đối chiếu với paper thay vì tin vì nó "nghe hợp lý" (Karpathy).
4. **Ghi chú lề có người đáp**: ở lượt 3, mỗi ghi chú phản biện bạn để bên lề ("chỗ này thiếu baseline?", "giả định này mạnh quá") được một "đồng nghiệp" AI trả lời ngay tại chỗ: đồng ý kèm chứng cứ trong paper, hoặc phản bác, hoặc hỏi lại. Bạn chọn một hay hai đồng nghiệp với góc nhìn khác nhau (ví dụ: người làm thực nghiệm khó tính · người làm lý thuyết).
5. **Phản biện**: bạn viết một review một trang theo mẫu của Mitzenmacher (tóm tắt · dàn ý: giả định, lập luận, dữ liệu, kết luận · hạn chế và mở rộng · đánh giá chất lượng và tác động); gia sư đóng vai người review thứ hai, so hai bản.
6. **Xong lượt 3 khi** (Keshav): bạn **dựng lại sườn paper từ trí nhớ** (các mục, ý chính mỗi mục, công thức và bảng then chốt) rồi so với paper thật; và chỉ ra được ít nhất một giả định ngầm và một chỗ thí nghiệm hoặc phân tích còn hở.

### D.7 Lượt 4 — Ghi nhớ và tổng hợp

1. **Giải thích cho người khác** (Feynman): ≤ 200 chữ, cho một bạn sinh viên năm ba, không dùng thuật ngữ chưa định nghĩa. Gia sư đóng vai bạn đó, hỏi lại đúng chỗ bạn nói mù mờ.
2. **Thẻ ôn** (Nielsen, Matuschak): gia sư đề xuất thẻ nhỏ; bạn **giữ / sửa / bỏ** từng thẻ, và tự viết thêm (viết thẻ cũng là học). Luật cho thẻ, bridge kiểm và báo khi vi phạm:
   - 5–20 thẻ cho mục tiêu "hiểu để dùng", nhiều hơn cho "hiểu sâu"; ít hơn 5 thẻ tốt thì không tạo thẻ nào (thẻ lẻ bị "mồ côi").
   - Mỗi thẻ một ý, câu hỏi chính xác, một đáp án nhất quán, trả lời được trong vài giây nhưng phải gắng nhớ; không có câu có/không.
   - Claim của paper ghi kèm nguồn ("Theo LoRA (Hu 2021), …"), không ghi như sự thật.
   - Mỗi ý quan trọng có 2–3 thẻ từ các góc khác nhau (sự kiện · vì sao · giống/khác · nhân/quả).
   Thẻ giữ lại vào lịch ôn ngắt quãng và hiện ở thẻ **Khởi động** trên trang chủ Mentor cùng các bài ôn, xen kẽ thẻ của nhiều paper.
3. **Ghi chú 5 câu** lên tủ paper (paper làm gì, mấu chốt, mình hiểu ra gì, còn nghi ngờ gì, muốn thử gì tiếp).
4. **Reproduce** (tùy chọn): mở xưởng của Mentor cho đúng paper này (không lấy lại nội dung); kế hoạch reproduce biết bạn đã hiểu tới đâu.

### D.8 Gia sư (luôn có trong khung chat)

- Hỏi gia sư bất cứ lúc nào. Bridge giữ phần văn bản của câu trả lời đến cuối lượt. Mỗi đoạn trình bày claim của paper cần có một câu trích tìm được trong văn bản paper để hiện trong chat. Chip trích dẫn cuộn tới đúng chỗ và tô sáng. Với lời giải thích từ kiến thức ngoài paper, suy luận hay gợi ý, gia sư dùng nhãn riêng.
- Câu trả lời tách rõ: *paper nói* · *kiến thức ngoài paper* · *suy luận của gia sư*.
- Với việc đang chờ bạn làm (checkpoint, 5C, câu đào sâu), gia sư không nói đáp án mà gợi ý theo thang 0–3; ngoài ra giải thích thẳng. Luật này do **bridge** giữ (đáp án của việc đang chờ không có trong ngữ cảnh của gia sư), không chỉ dựa vào lời dặn trong prompt: prompt một mình không giữ được cấu trúc (Kestin et al.; OpenAI tự nhận Study Mode "không nhất quán"), và trợ giúp AI không rào chắn làm *giảm* kỹ năng tự làm sau đó (Bastani et al.).
- Không có thanh trượt "giải thích kiểu người mới ↔ chuyên gia": LLM chỉ đổi độ phức tạp đúng hướng 33–46 % số lần. Thay vào đó là các *loại* trợ giúp rõ ràng: Giải thích · Ví dụ cụ thể · Ký hiệu · Vì sao · Kiến thức nền.
- Nút **Hỏi tôi một câu**: gia sư hỏi bạn một câu về phần vừa đọc (ôn bằng cách nhớ lại, không phải đọc lại).

### D.9 Trên tủ paper và trang chủ Mentor

```
📜 LoRA · Hu et al. 2021            Đọc: ② Hiểu 3/7 mục · vững 64 %       [ Đọc tiếp ▶ ]  [ Reproduce ]
   Khái niệm yếu: α/r scaling · vì sao chỉ W_q, W_v       Thẻ ôn đến hạn: 4
```

- Đọc một paper (có ít nhất một checkpoint hoặc một đoạn tự viết trong ngày) tính là một ngày học cho chuỗi ngày của Mentor.

---

## E. Thiết kế kỹ thuật

### E.1 Sơ đồ

```
VS Code                                     bridge (bridge/src/reader)                     ngoài
 tab "Đọc: <paper>" (reader.js, Preact)      ReaderHub: nạp paper, kho, mô hình tiến độ
   bài báo (HTML arXiv / PDF) + công cụ ─WS─► ingest.ts ──────────────────────────────────► arxiv.org/html, ar5iv,
   widget trong iframe sandbox                                                              e-print, export.arxiv.org
 khung chat bên phải (ui, như Mentor) ─WS─►  Chat (role = ReaderChat: gia sư)   ACP ─► agent (Claude Code, Codex…)
   thanh 4 lượt, chip trích dẫn [§3.2]        playbook <reader>, tool paper_* / reader_*
                                             Chat ẩn (role = ReaderAuthor: người soạn)   ACP ─► cùng agent
                                             Chat ẩn ngắn (role = ReaderChecker: người kiểm, giải mù)
 luồng ghi chú ở lề (lượt 3)          ─WS─►  Chat ẩn (role = ReaderPeer: đồng nghiệp phản biện)
 tủ paper (Mentor) ◄── reader.updated ────   events.jsonl (dùng chung với Mentor) → fold → tiến độ, thẻ ôn
 "Reproduce" ─────────────────────────────►  mentor.paper.add / open (xưởng sẵn có)
```

Không đụng extension Chrome. Không cần notebook để đọc: notebook chỉ cần cho lab Python (E.7.4) và cho reproduce (Mentor).

### E.2 Nạp paper: `ReaderDoc`

Một paper có hai thứ: **bản để người đọc nhìn** (giữ nguyên trình bày, công thức, hình) và **bản chữ để agent đọc** (công thức dạng TeX, có mốc để trích). Cả hai sinh ra cùng lúc, chung một hệ mốc.

| Nguồn (thứ tự thử) | Bản để nhìn | Bản chữ cho agent | Mốc |
|---|---|---|---|
| `arxiv.org/html/<id>` (LaTeXML; ER-0: có cả paper cũ đã được chuyển ngược, 15/16 paper thử) | HTML đã làm sạch, hình tải về máy | chữ từ HTML, mỗi công thức lấy TeX gốc ở `alttext` của `<math>` (ER-0: 100 % công thức có) | id của LaTeXML: mục `S4.SS1`, đoạn `S1.p3`, công thức `S2.E1`, hình/bảng `S1.F1`/`S3.T1` |
| `ar5iv.labs.arxiv.org/html/<id>` (dự phòng) | như trên | như trên | như trên |
| e-print LaTeX (`fetch.ts: fetchArxiv`, đã có) | PDF của arXiv qua pdf.js | LaTeX đã ghép | số trang + câu trích |
| File PDF của bạn | pdf.js (canvas + lớp chữ) | chữ rút bằng pdf.js **trong webview** (không cần máy Kaggle) + ảnh trang khi agent cần nhìn công thức | số trang + câu trích |

- Đã kiểm thử tay với LoRA (`2106.09685v2`): HTML 500 KB, có `section#S1…`, `id="S2.E1"`, `<math alttext="\Delta W…">`, `figure#S1.F1`, ảnh dạng đường dẫn tương đối.
- HTML của arXiv: trên toàn kho ~75 % chuyển không lỗi, nhưng với paper ML ER-0 thấy dấu lỗi hiếm và nhỏ (10/15 không có; còn lại 1–11 dấu, đều là macro lạ như `\reportnumber`). Vì vậy chỗ lỗi được giữ như LaTeXML in ra, có đánh dấu nhẹ; **cả paper** chuyển sang PDF khi chuyển đổi hỏng. Chuyển đổi hỏng vẫn trả 200 (trang "Untitled Document" rỗng, hoặc ar5iv với mỗi trang PDF là một ảnh): nhận ra bằng điều kiện không có `ltx_section` và < 10 `<math>`.
- Nguồn LaTeX chỉ bọc một PDF (`\includepdf`, như PPO 1707.06347): cả HTML lẫn LaTeX vô dụng → đường PDF, chữ cho agent rút bằng pdf.js.
- Hình: đường dẫn tương đối giải theo URL trang (`https://arxiv.org/html/<id>` → `…/html/<id>v<n>/x1.png`); bỏ logo arXiv và biểu tượng `data:` của trang. Danh sách tham khảo là tùy chọn (DeepSeek-R1 không có `ltx_bibitem` nào).
- Dự phòng rẻ cho chữ: `huggingface.co/papers/<id>.md` (markdown dựng từ HTML arXiv) khi e-print không có LaTeX.
- Lịch sự với arXiv: API metadata tối đa 1 yêu cầu / 3 giây, tuần tự; hình tải tuần tự; mọi thứ lưu cục bộ để không tải lại. Chỉ dùng cho cá nhân, không phục vụ lại file nguồn cho người khác (điều khoản của arXiv).
- Macro của tác giả (`\newcommand`, `\def` trong preamble — `flattenLatex` đã giữ lại) được đưa vào option `macros` của KaTeX, nên công thức dùng macro riêng vẫn vẽ đúng.
- PDF của bạn: dò dấu `arXiv:XXXX.XXXXX` ở trang đầu (arXiv in dọc lề trái) hoặc tìm theo tên trên API arXiv; tìm thấy thì hỏi "Dùng bản arXiv (công thức chuẩn hơn)?" và nạp lại theo đường arXiv.
- Mốc chung cho mọi nguồn là **câu trích** (đúng chữ trong paper, kiểu `TextQuoteSelector` của W3C: `exact` + vài chữ trước/sau). Có id thì dùng id cho nhanh; không có thì màn đọc tìm câu trích để cuộn tới và tô sáng. Nhờ vậy cùng một cơ chế chạy cho HTML lẫn PDF.
- `ReaderDoc` (lưu `reader/doc.json`):

```ts
interface ReaderDoc {
  paperId: string; title: string; authors?: string; year?: number; arxiv?: string;
  view: "html" | "pdf";                 // màn đọc vẽ gì
  text: "html" | "latex" | "pdf";       // agent đọc gì (độ tin của công thức)
  sections: { id: string; number?: string; title: string; level: 1 | 2 | 3; parent?: string; blocks: string[]; minutes: number }[];
  blocks: { id: string; section: string; kind: "p" | "eq" | "fig" | "table" | "alg" | "list"; text: string; tex?: string; caption?: string; img?: string; page?: number }[];
  refs: { id: string; text: string; arxiv?: string; doi?: string }[];
}
```

- Giới hạn như Mentor: chữ tối đa 600 000 ký tự; agent đọc theo mục hoặc theo trang 40 000 ký tự.

### E.3 Kho

Paper là **một** thư mục, dùng chung với Mentor: `~/.agent-in-notebook/mentor/papers/<paperId>/` (id như `paperIdFor`: `arxiv-2106-09685`). Thêm thư mục con `reader/`:

```
paper.json          (sẵn có) + khối "reader": { goal, pass, startedAt, doneAt? }
source.md           (sẵn có) chữ cho agent
reader/
  doc.json          ReaderDoc
  doc.html          HTML đã làm sạch (chế độ html)   ·  paper.pdf (chế độ pdf)
  assets/           hình của paper, ảnh trang PDF agent đã xin
  map.json          bản đồ paper do người soạn làm (E.4.2): vai trò từng đoạn, 5C tham chiếu, khái niệm, ký hiệu, kiến thức nền
  items/<section>.json   câu hỏi của từng mục (đã qua kiểm, E.6)
  deep.json         câu hỏi đào sâu + rubric
  widgets/<id>/     spec.json, model.js, view.js, check.json (E.7)
  cards.json        thẻ ôn bạn đã giữ
  mine.md           ghi chú và "câu hỏi của tôi"
```

- `PaperShelf` (`mentor/papers.ts`) hiện coi mọi paper trong tủ là đang có xưởng (`status: "reading"` là xưởng đang đọc). Thêm trạng thái `"shelved"` (chưa mở xưởng) để paper mở bằng easy-read không hiện như một xưởng dở; `mentor.paper.add` với paper đã có trong tủ thì mở xưởng như hiện nay.
- **Đã đổi ở ER-1:** nhật ký đọc là `reader/events.jsonl` **riêng của từng paper**, không phải `mentor/events.jsonl`. Lý do: Mentor nén nhật ký của nó (quá 5 000 sự kiện) thành một ảnh chụp chỉ Mentor hiểu, nên sự kiện `r.*` để ở đó sẽ mất khi nén. Từ nhật ký riêng gập ra tiến độ, đánh dấu và ghi chú (`foldReader`, bỏ qua sự kiện lạ và dòng hỏng). ER-1 có `r.open`, `r.section`, `r.mark`, `r.note`, `r.noteRemove`; khi cần tính vào chuỗi ngày học và Sổ lỗi sai (ER-4), reader ghi thêm một dòng tóm tắt vào nhật ký Mentor. Bảng dưới là kế hoạch cho các bước sau, đọc "nhật ký" là nhật ký của paper.
- Paper mở bằng easy-read lên tủ với `status: "shelved"`; mở xưởng (Mentor) thì chuyển sang `"reading"`. Trang chủ Mentor có nút **📖 Đọc** trên thẻ paper.
- (Kế hoạch ban đầu) Nhật ký dùng chung `mentor/events.jsonl` (nguồn sự thật, như Mentor). Sự kiện mới, `attemptId: "reader:<paperId>"` để `fold` cũ bỏ qua an toàn:

| Sự kiện | Ý nghĩa |
|---|---|
| `{ t: "r.open", paperId, source }` | mở paper lần đầu (tính ngày học khi có hoạt động khác cùng ngày) |
| `{ t: "r.pass", paperId, pass, what: "start" \| "done" }` | qua lượt |
| `{ t: "r.section", paperId, section, ms }` | thời gian đọc một mục (gộp theo phiên, không ghi từng giây) |
| `{ t: "r.write", paperId, kind: "5c" \| "explain" \| "summary" \| "review", section?, grade?: 0\|1\|2 }` | bạn viết một đoạn của mình; `grade` do gia sư chấm theo rubric |
| `{ t: "r.answer", paperId, item, correct, confidence: 1\|2\|3, firstTry: boolean }` | trả lời một câu hỏi |
| `{ t: "r.card", paperId, card, grade: "again" \| "hard" \| "good" }` | ôn một thẻ |
| `{ t: "r.skip", paperId, item }` | bạn bấm "Cho xem luôn" ở một việc đang chờ: đáp án mở, việc đó không tính vào tiến độ |
| `{ t: "r.report", paperId, item, reason }` | báo câu hỏi/widget sai: rút khỏi bộ, ghi lại |
| `misconception` (sẵn có), `tag: "paper:<id>:<concept>"` | hiểu sai lộ ra khi trả lời: vào Sổ lỗi sai của Mentor, hỏi lại theo lịch sẵn có |

### E.4 Bốn vai agent và việc của từng vai

Như xưởng paper: một chat **hiện** để làm việc với bạn, các chat **ẩn** làm việc nặng phía sau. Tất cả là `Chat` của lõi với một `ChatRole` riêng (`chat-role.ts`), chạy **đúng agent và cấu hình của gia sư** (agent, model và các tùy chọn khác; trừ chế độ phiên của agent, để chat ẩn vẫn bị chặn dùng công cụ trên máy). Không có cấu hình agent riêng cho vai nào (E.4.5).

#### E.4.1 Gia sư (`ReaderChat`, hiện trong khung chat)

- Khóa transcript `reader:<paperId>`; đích của chat là tab đọc (không phải notebook). Settings cố định như `MENTOR_SETTINGS`, ẩn bộ chọn Mode/Review.
- Playbook `<reader>` (tóm tắt luật):
  1. Nói tiếng Việt, giữ thuật ngữ tiếng Anh; lần đầu gặp thuật ngữ thì kèm nghĩa.
  2. **Mọi câu về nội dung paper phải kèm mốc** `[[S3.SS2]]`, `[[S2.E1]]`, `[[p4: "…câu trích…"]]`. Tách rõ ba loại: *paper nói* (có mốc) · *kiến thức ngoài paper* · *suy luận của tôi*.
  3. Không làm hộ phần việc của bạn: khi một câu hỏi checkpoint, 5C, hay câu đào sâu đang chờ bạn trả lời (`<reader-state>` liệt kê), không nói ra đáp án; được hỏi thì đưa gợi ý theo **thang trợ giúp** (0 câu hỏi dẫn · 1 hướng đi · 2 giải thích một phần · 3 giải thích đủ + ví dụ). Ngoài các việc đang chờ, giải thích thẳng và đầy đủ khi bạn hỏi.
  4. Khi bạn giải thích lại (self-explanation, Feynman), chấm theo rubric bằng `reader_grade`, phân biệt *diễn đạt lại* với *giải thích* (nói được vì sao, nối với điều đã biết), chỉ ra đúng chỗ thiếu/sai, hỏi một câu tiếp theo thay vì đưa ngay bản đúng. Xây trên câu trả lời của bạn, không giảng lại từ đầu (ICAP: tương tác là hai bên cùng kiến tạo).
  5. Ý nào cần thấy mới hiểu (một tham số, một phân phối, một thuật toán chạy từng bước) thì đề xuất ví dụ tương tác (`reader_widget_request`); bạn đồng ý thì người soạn làm.
  6. Hiểu sai lộ ra thì ghi bằng `reader_misconception` (vào Sổ lỗi sai).
- `<reader-state>` mỗi lượt: mục tiêu đọc, lượt hiện tại, mục đang nhìn, đoạn đang chọn (kèm chữ), các việc đang chờ bạn làm, khái niệm còn yếu, thẻ ôn đến hạn của paper.
- Hai nút trên tab đọc gửi tin thay bạn: chọn một đoạn → **Giải thích** / **Ví dụ cụ thể** / **Ký hiệu này** / **Vì sao?** (tin nhắn mang `<reader-selection anchor=… >chữ đã chọn</reader-selection>`).

#### E.4.2 Người soạn (`ReaderAuthor`, chat ẩn, chạy nền)

Chạy nền **độc lập với chat gia sư**: khác xưởng (nơi người soạn giữ `busyJob` vì hai chat tranh một kernel), ở đây không có kernel chung, nên bạn vẫn hỏi gia sư trong lúc người soạn làm việc. Tiến độ hiện trên thanh lượt của tab đọc, có nút Dừng; transcript `reader-author:<paperId>` chỉ để gỡ lỗi. Việc xếp hàng tuần tự, **soạn trước một bước so với bạn** (không soạn cả paper một lúc):

| Việc | Khi nào | Kết quả |
|---|---|---|
| `map` | ngay khi nạp (2–4 phút) | vai trò từng đoạn (mục tiêu · đóng góp · phương pháp · kết quả · hạn chế), đáp án tham chiếu 5C, kiến thức nền cần có, danh mục khái niệm (mỗi khái niệm có mốc), bảng ký hiệu (ký hiệu → nghĩa → shape nếu là tensor → mốc định nghĩa), câu hỏi tiền kiểm (pretest) |
| `section <id>` | khi bạn bắt đầu mục trước đó | câu dẫn trước khi đọc; ý chính + chứng cứ tham chiếu (để chấm phần nhớ lại); chỗ then chốt để tự giải thích, kèm rubric; câu hỏi Đọc hình cho hình/bảng của mục; phiếu QALMRI tham chiếu nếu là mục thí nghiệm; 3–6 câu hỏi checkpoint; đề xuất thẻ ôn |
| `widget <concept>` | khi bạn hoặc gia sư yêu cầu | một widget qua kiểm (E.7) |
| `deep` | khi bạn vào lượt 3 | 5–8 câu đào sâu kèm rubric và bài mẫu; các bước dẫn công thức (cho mẫu mờ dần); đoạn "tìm chỗ sai" kèm danh sách lỗi cài sẵn, mỗi lỗi có câu trích của paper bác bỏ nó (qua kiểm câu trích như E.6) |

Tool của người soạn: `paper_read`, `paper_find`, `paper_figure`, `paper_page`, `reader_map_write`, `reader_items_write`, `reader_deep_write`, `reader_widget_write`, `reader_widget_check`. Mọi thứ ghi vào đều qua zod và các phép kiểm ở E.6, sai thì bị từ chối kèm lý do để agent sửa (như `paper_plan`).

#### E.4.3 Người kiểm (`ReaderChecker`, chat ẩn ngắn)

Một phiên mới, **không thấy đáp án**: nhận câu hỏi trắc nghiệm cùng đoạn trích của nó, tự trả lời. Khác đáp án của người soạn → câu bị trả lại cho người soạn kèm lời giải thích của người kiểm. Đóng sau mỗi lô để không mang ngữ cảnh cũ.

#### E.4.4 Đồng nghiệp lề (`ReaderPeer`, chat ẩn, lượt 3)

Một chat ẩn cho mỗi góc nhìn bạn chọn (tối đa hai), khóa `reader-peer:<paperId>:<persona>`. Mỗi ghi chú lề của bạn thành một lượt; câu trả lời hiện thành luồng ở lề (không vào khung chat), có mốc. Tool: `paper_read`, `paper_find`, `reader_margin_reply`. Persona là một đoạn trong playbook (`<reader-peer persona="experimentalist">`), không phải agent khác.

#### E.4.5 Bạn quyết định khi nào agent nền chạy

Mỗi lượt của agent nền là một yêu cầu tính phí, nên bạn quyết định khi nào nó chạy. Cài đặt nằm trong `reader.json`, chỉnh ở mục **Agent nền (Easy-read)** của khung chat:

- **Chạy** (`agentMode`):
  - `ask` (mặc định): việc các lượt chuẩn bị trước (bản đồ paper khi chọn mục tiêu; checkpoint hai mục kế tiếp khi sang lượt 2 hay đọc tới; bài đào sâu; thẻ ôn) chỉ hiện thành **đề xuất** trên thanh người soạn, kèm số lượt agent tối đa. Agent chỉ chạy khi bạn bấm **Soạn** (hoặc **Soạn tất cả**, hay **Soạn checkpoint mục này** trên thẻ của mục).
  - `auto`: các việc đó tự chạy, như trước.
  - `off`: không việc nào chạy, kể cả khi bấm.
- **Khóa agent cho paper này** (công tắc trên thanh Agent nền, lưu trong `reader/author.json` của paper): dừng ngay việc đang chạy, đưa nó về danh sách đề xuất, và không agent nền nào chạy cho paper đó (kể cả khi bấm Soạn, ở `auto`, hay sau khi khởi động lại) cho tới khi bạn bỏ khóa. Bỏ khóa không tự chạy gì.
- **Thanh Agent nền** luôn hiện phía trên paper: chọn chế độ Chạy (áp dụng cho mọi paper, giống cài đặt ở khung chat), công tắc khóa, việc đang chạy, và một dòng thu gọn "N việc chờ duyệt · tối đa M lượt agent" mở ra danh sách. Checkpoint của từng mục được bấm Soạn trên thẻ mục ở lượt 2 (thanh chỉ đếm). **Soạn tất cả** hỏi xác nhận khi tổng vượt 10 lượt. Số lượt đã chạy luôn hiện ở thanh tiêu đề của tab ("Agent nền: N lượt").
- **Giải mù câu hỏi** (`checker`, mặc định bật) chạy kèm mỗi checkpoint bạn bấm Soạn. Tắt thì câu hỏi tới tay bạn với nhãn "chưa kiểm". **Số vòng sửa** (`checkerRounds`, 0–2, mặc định 2) giới hạn số lần câu bị trả lại cho người soạn.
- Số lượt tối đa của một checkpoint: 3 lượt soạn, mỗi lần kiểm tối đa 2 lượt (`checkerRounds + 1` lần), mỗi vòng sửa 1 lượt soạn. Với cài đặt mặc định là 11 lượt.
- Mỗi lượt gửi tới chat ẩn (soạn, kiểm, đồng nghiệp lề) được đếm trong `reader/usage.json` và hiện trên thanh người soạn. Lượt chat với gia sư không tính vào đây.
- **Một cấu hình agent duy nhất là của gia sư**: người soạn, người kiểm và đồng nghiệp lề chạy đúng agent của chat gia sư đang mở, chép mọi tùy chọn của nó (model, mức suy luận…; trừ chế độ phiên). Chat gia sư đóng thì không agent nền nào chạy: việc chuẩn bị trước chỉ thành đề xuất, kể cả ở `auto`; tab đọc mở chat gia sư trước khi một cú bấm Soạn chạy. Không còn fallback ngầm sang agent khác. (`ainb reader eval --quiz` là ngoại lệ dành cho dev: nó chọn agent bằng tham số của nó.)
- Việc bạn tự yêu cầu (ví dụ tương tác từ một đoạn chọn, nhận ví dụ gia sư đề xuất, Soạn lại) chạy ngay, trừ khi chế độ là `off`.

### E.5 Tool

| Tool | Ai dùng | Làm gì |
|---|---|---|
| `paper_read { section? , offset? }` | mọi vai | chữ của một mục (công thức dạng TeX), hoặc theo trang 40 000 ký tự |
| `paper_find { query }` | mọi vai | tìm trong paper, trả đoạn kèm mốc |
| `paper_figure { id }` | gia sư, người soạn | ảnh hình/bảng (đính kèm ảnh như `Attachments` của lõi) và chú thích |
| `paper_page { page }` | gia sư, người soạn | ảnh một trang PDF (màn đọc vẽ bằng pdf.js rồi gửi về), để nhìn công thức khi chỉ có chữ rút từ PDF (ER-0: pdf.js đưa Eq. 3 của LoRA thành `h = W 0 x + ∆ W x = W 0 x + BAx`). JPEG tỉ lệ 1,5 (~250 KB; PNG tỉ lệ 2 là ~470 KB, mà một kết quả tool chỉ gửi được 4 ảnh / 3 MB) |
| `reader_grade { target, grade, missing[], feedback }` | gia sư | chấm đoạn bạn viết theo rubric → sự kiện `r.write` |
| `reader_misconception { concept, note }` | gia sư | Sổ lỗi sai |
| `reader_widget_request { concept, goal }` | gia sư | xếp việc `widget` cho người soạn |
| `reader_card_propose { front, back, anchor }` | gia sư, người soạn | đề xuất thẻ ôn (bạn giữ / sửa / bỏ) |
| `reader_map_write`, `reader_items_write`, `reader_deep_write` | người soạn | ghi kết quả, qua kiểm E.6 |
| `reader_widget_write`, `reader_widget_check` | người soạn | ghi widget, chạy tự kiểm E.7 |
| `paper_search`, `paper_read` của OpenResearch (`project/tools.ts`) | gia sư (tùy chọn) | tìm paper liên quan khi có `orx`. **ER-1: chưa bật.** Chat gia sư không có MCP server "project" (như chat Mentor), vì `paper_read` của nó trùng tên với tool của gia sư; muốn bật thì đổi tên một bên trước (`reader-contract.test.ts` canh) |

`isNotebookTool` (`chat.ts`) phải nhận thêm tên `reader_*` (hiện nhận `mentor_*`, `paper_*`) để chế độ Notebook only không chặn chúng.

### E.6 Câu hỏi: định dạng và kiểm chất lượng

```ts
// Như đã làm ở ER-2 (bridge/src/reader/items.ts). `predict` là một mcq viết theo kiểu dự đoán; `cloze` chưa làm.
interface ReaderItem {
  id: string;            // bridge đặt: băm của mục + chữ câu hỏi, nên câu giữ nguyên thì giữ được câu trả lời
  unit: string; concept: string;
  bloom: "remember" | "understand" | "apply" | "analyze" | "evaluate" | "create";
  kind: "mcq" | "multi" | "twotier" | "numeric" | "order" | "match";
  stem: string;                                                  // Markdown + TeX
  options?: { text: string; correct: boolean; why: string }[];   // why: vì sao sai = hiểu sai nào
  reasons?: { text: string; correct: boolean; why: string }[];   // twotier: tầng "vì sao"
  numeric?: { value: number; tolerance: number; measure?: string };
  steps?: string[];                                              // order: đúng thứ tự (tab xáo)
  pairs?: { left: string; right: string }[];                     // match
  evidence: { anchor: string; quote: string }[];                 // câu trích đúng chữ trong paper
  explain: string;                                               // giải thích sau khi trả lời, có mốc
  difficulty: 1 | 2 | 3 | 4 | 5;
  authorBloom?: string;  // mức người soạn ghi, khi người kiểm xếp khác (bloom là của người kiểm)
  unchecked?: true;      // người kiểm không chạy được: câu vẫn đến tay bạn, có đánh dấu
}
```

Tab không bao giờ nhận `correct`/`why` trước khi bạn trả lời: nó nhận phương án đã xáo theo một thứ tự cố định cho từng câu (không bao giờ là thứ tự của người soạn), gửi lựa chọn của bạn, bridge chấm rồi mới trả lời giải.

Một câu chỉ đến tay bạn khi qua **cả** các phép kiểm sau (thứ tự từ rẻ tới đắt):

| # | Phép kiểm | Ai làm |
|---|---|---|
| 1 | Đúng schema và **luật viết câu** (Haladyna et al.; bộ kiểm theo luật bắt 91 % lỗi viết câu, hơn GPT-4 tự kiểm 79 % — Moore et al.): trắc nghiệm **3 phương án** (tối đa 4), đúng một đáp án đúng (multi: ≥ 1); không "tất cả/không phương án nào"; phương án cùng loại, dài xấp xỉ nhau (đáp án đúng không dài hẳn ra); thân câu khẳng định, chứa ý chính; mỗi phương án sai có `why` nêu hiểu sai nó đại diện; vị trí đáp án đúng được trộn; hai tầng thì tầng lý do có lý do đúng và ≥ 2 hiểu sai | bridge (zod + `reader/lint.ts`, như `mentor/lint.ts`) |
| 2 | Mỗi `quote` có thật trong paper (so sau khi chuẩn hóa khoảng trắng, dấu, TeX) | bridge — chặn câu hỏi bịa nguồn, gần như không tốn gì |
| 3 | Đáp án suy ra được từ đoạn trích: người kiểm **giải mù** ra đúng đáp án, và không thấy phương án nào khác cũng đúng (GPT-4 viết câu nhiều đáp án đúng 4,9 % số lần, gấp 4 lần người — Doughty et al.) | người kiểm |
| 4 | Mức Bloom: người kiểm tự xếp mức của câu; lệch nhãn của người soạn thì đổi nhãn theo người kiểm (LLM chỉ ra đúng mức yêu cầu ~66 % — Scaria et al.). Mỗi mục phải có ≥ 1 câu từ mức Áp dụng trở lên | người kiểm + bridge |
| 5 | Không trùng ý với câu đã có của cùng khái niệm và cùng mức Bloom | bridge (so chữ đơn giản) |
| 6 | Sau khi dùng: bạn bấm **Báo câu sai** → câu bị rút, lý do vào `reports` | bạn |

Prompt của người soạn theo kết quả của Scaria et al.: suy luận từng bước + mô tả mức Bloom cần đạt + **một** câu mẫu tốt; giữ prompt ngắn.

Câu đào sâu (`deep.json`) không có đáp án đóng: mỗi câu có **rubric** (2–4 ý chính bắt buộc, các hiểu sai hay gặp, thế nào là 0/1/2) và **bài mẫu tham chiếu** trích từ paper. Cách chấm, theo những gì đã biết về LLM chấm bài (Zheng et al.; Jiang & Bosch: QWK ~0,68):

- Chấm **có tham chiếu** (rubric + bài mẫu), gia sư tự giải câu hỏi trước khi đọc bài của bạn; dặn rõ không cộng điểm cho độ dài.
- Nhận xét phải trích đúng câu chữ của bạn cho từng ý của rubric (có/thiếu/sai).
- Bạn sửa được một lần rồi mới hiện bài mẫu; bạn **phản đối** được ("mình nghĩ ý 2 đã có ở câu …") và gia sư chấm lại một lần.
- Điểm tự luận chỉ để học: vào tiến độ của paper, **không** vào rating Elo của Mentor.

Thẻ ôn (`reader_card_propose`, thẻ bạn tự viết) qua `reader/cards.ts`: một câu hỏi một ý (không có "và"/liệt kê dài), không phải câu có/không, đáp án ngắn, claim có ghi nguồn, không trùng thẻ đã có; phần không kiểm bằng máy được (đáp án nhất quán, cần gắng nhớ) do người kiểm đọc lại một lượt.

### E.7 Ví dụ tương tác (widget)

Widget từ ER‑3 dùng biểu thức số và bộ hiển thị của tab đọc. `reader/widgets.ts` kiểm mốc trích, toán tử, độ sâu, khoảng tham số và các giá trị đối chiếu trước khi lưu `spec.json`. `ui/src/reader/widget-host.tsx` vẽ thanh trượt, lựa chọn, công tắc, bảng, ma trận, đồ thị, từng bước và so sánh từ spec đã kiểm. Bridge mở mô hình và đáp án sau dự đoán hoặc khi người đọc chọn **Cho xem luôn**. Bản khảo sát JavaScript và iframe dưới đây ghi lại thiết kế đã thử trong ER‑0.

#### E.7.1 Định dạng

```
widgets/<id>/
  spec.json   { id, title, concept, anchors[], goal, predict?: { question, choices? }, params: [{ name, label, min, max, step, init }] }
  model.js    phần tính toán thuần: export function compute(params) {...}; export const tests = [{ name, run() }]
  view.js     phần vẽ, chỉ dùng bộ kit: Kit.slider/select/toggle, Kit.plot (đường, điểm, heatmap), Kit.matrix, Kit.tex, Kit.steps (chạy từng bước), Kit.compare (hai cấu hình cạnh nhau)
```

- Tách **tính** khỏi **vẽ** để kiểm được phần tính như máy chấm của Mentor kiểm lời giải: `tests` là các bất biến lấy từ paper (ví dụ: "ᾱ_t giảm dần theo t", "t = 0 thì x_t = x_0", "softmax mỗi hàng cộng lại bằng 1", "số tham số của LoRA = r·(d+k)").
- `predict` bật kiểu *đoán trước, xem sau*: widget khóa thanh trượt cho tới khi bạn chọn một dự đoán; sau đó so dự đoán với kết quả và ghi `r.answer`.

#### E.7.2 Chạy an toàn trong webview

1. **Tự kiểm**: màn đọc chạy `model.js` + `tests` trong một Web Worker từ blob, hết 2 giây thì `terminate()` (vòng lặp vô hạn không treo màn đọc). Kết quả gửi về bridge (`reader.widgetCheck`), trả cho người soạn qua `reader_widget_check`. Hỏng → người soạn sửa, tối đa 3 vòng như xưởng.
2. **Hiển thị**: qua kiểm rồi mới vẽ, trong `<iframe sandbox="allow-scripts">` (không `allow-same-origin`: origin mờ, không chạm được VS Code API hay trang đọc). Kit và code được ghép thành `srcdoc`; tài liệu `srcdoc` thừa kế CSP của webview, nên **không gọi mạng được** (`default-src 'none'`), script phải mang nonce do màn đọc gắn vào khi ghép.
3. Lỗi lúc chạy (`window.onerror`) gửi lên trang cha bằng `postMessage` (trang cha kiểm `event.source`), rồi về người soạn như một lần kiểm hỏng.
4. Giới hạn: `view.js` + `model.js` ≤ 200 KB, không thư viện ngoài kit.

Đã thử trong VS Code 1.147 thật (ER-0, `docs/easy-read-er0.md` § 3): `srcdoc` + `sandbox="allow-scripts"` chạy script mang nonce, không cần `frame-src`; origin mờ, không chạm được trang cha, storage hay VS Code API; `fetch`, `WebSocket`, ảnh từ mạng đều bị chặn; Worker từ blob chạy và `terminate()` được. Từ đó, **luật cho bộ kit và code widget** (`reader/widgets.ts` kiểm trước khi nhận): không `eval`/`new Function` (bị chặn), không thuộc tính sự kiện nội dòng như `onclick=` (bị chặn; dùng `addEventListener`), mọi `<script>` mang nonce do màn đọc gắn khi ghép `srcdoc`.

#### E.7.3 Loại widget người soạn được gợi ý

| Loại | Ví dụ | Dùng khi |
|---|---|---|
| Thanh trượt công thức | `β_t` schedule của DDPM; nhiệt độ softmax; `α/r` của LoRA | một công thức có tham số |
| Chạy từng bước | attention trên 4 token có số cụ thể; một bước PPO clip | thuật toán, phép tính nhiều bước |
| Ví dụ số tí hon | ma trận 3×3 đi qua từng phép biến đổi, có shape | "công thức → tensor" (đúng chỗ yếu Mentor đang luyện) |
| So sánh hai cấu hình | có/không shortcut; r = 1 với r = 64 | claim dạng "A tốt hơn B vì…" |
| Theo dấu shape | tensor đi qua kiến trúc, shape từng bước | kiến trúc mạng |

#### E.7.4 Lab Python trên notebook (tùy chọn)

Nút **Mở thành lab trên notebook** dùng trình chọn notebook Kaggle của Mentor. Lab nối câu trích, lời giải thích, câu dự đoán và một cell Python chuyển từ công thức của widget. Cell đầu có dấu `<!-- reader: lab <paperId> <widgetId> -->` để tiếp tục lần chép dở. Người đọc chủ động chạy cell. Các bài cần PyTorch, dữ liệu thật hoặc chấm tự động đi qua **Reproduce**.

### E.8 Mô hình tiến độ và ôn tập

Tiến độ gộp từ nhật ký (`reader/model.ts: foldReader`). Điểm checkpoint dùng thang Gardner-Medwin. Độ vững chỉ tính câu trả lời từ một ngày sau lần đọc, lấy lần đủ điều kiện gần nhất của từng câu và tính trọng số Bloom 1 + 0,5·bậc. Câu đoán đúng tính nửa. **Hỏi tôi một câu** ưu tiên khái niệm yếu và mức Bloom kế tiếp.

- **Mỗi mục**: đã đọc (thời gian ≥ 40 % ước lượng hoặc bạn đánh dấu), đã tự giải thích (grade ≥ 1), checkpoint (tỉ lệ đúng lần đầu).
- **Mỗi khái niệm**: độ vững 0–1 = trung bình có trọng số các lần trả lời, trọng số tăng theo mức Bloom; câu tiếp theo nhắm khái niệm yếu nhất và mức Bloom cao hơn một bậc so với mức bạn đã vững.
- **Điểm theo độ chắc chắn** (Gardner-Medwin): mức 1 đúng +1 / sai 0; mức 2 +2 / −2; mức 3 +3 / −6. Không thể có lợi khi khai sai độ chắc, nên điểm vừa đo hiểu vừa đo **biết mình hiểu tới đâu**. Hiện riêng hai ô "chắc mà sai" (hiểu sai thật, ưu tiên ôn, vào Sổ lỗi sai) và "đoán mà đúng" (chưa vững, hỏi lại).
- **Lặp tới khi đúng** (Dunlosky): câu sai quay lại cuối buổi và lần đọc sau, tới khi đúng một lần; điểm checkpoint ngay sau khi đọc không được coi là bằng chứng đã nhớ (đọc lại làm tự tin tăng dù nhớ kém hơn — Roediger & Karpicke). Tiến độ "vững" của một khái niệm chỉ tính các lần trả lời **cách lần đọc ≥ 1 ngày**.
- **Thẻ ôn**: lịch kiểu Quantum Country — ôn ngay trong lượt 4, rồi 5 ngày, 2 tuần, 1 tháng, 2 tháng, 4 tháng; quên ("again") thì về 5 ngày, "khó" giữ bậc. Mục tiêu "hiểu để dùng" dừng ở 1 tháng; "hiểu sâu" đi hết thang (Cepeda: khoảng cách hợp lý tùy bạn muốn nhớ bao lâu). Thẻ đến hạn của mọi paper hiện ở thẻ **Khởi động** trên trang chủ Mentor (cùng chỗ bài ôn), **xen kẽ** các paper, mỗi lần tối đa 10 thẻ.
- **Paper "đã hiểu sâu"** khi: đủ 4 lượt; mọi mục có checkpoint ≥ 70 % đúng lần đầu; ≥ 3 câu đào sâu đạt 2/2; dựng lại sườn paper từ trí nhớ đạt; bản giải thích Feynman đạt; và lần ôn thẻ đầu tiên (sau 5 ngày) nhớ ≥ 80 %.

### E.9 Giao thức (thêm, `WIRE_VERSION` giữ 6 nếu chỉ thêm method và field tùy chọn)

**Đã có ở ER-1** (`protocol/src/reader.ts`, `wire.ts`; `WIRE_VERSION` vẫn 6): `ReaderView { paperId, title, authors?, year?, arxiv?, url?, view: "html"|"pdf", text: "html"|"latex"|"pdf", needsText?, dir, file, sections: { id, number?, title, level, parent?, minutes, readMs, read, empty? }[], notes, at?, warnings, arxivHint?, openedAt, lastAt }`; `ChatSnapshot.reader?: { paperId, title }`; `chat.open` nhận `reader: { paperId }`. Method: `reader.open { source }`, `reader.get`, `reader.list`, `reader.progress { section, ms }`, `reader.mark { section, read }`, `reader.note { note? | remove? }`, `reader.pdfText { pages, title? }` (tab gửi chữ rút bằng pdf.js), `reader.rendered { page? | asset?, jpeg? | error? }`, `reader.ask { chatId, kind, anchor, quote }`. Event: `reader.updated { paperId, view }` (chỉ khi có gì đổi: một mục vừa thành đã đọc, đánh dấu, ghi chú), `reader.render { paperId, page? | asset? }` (gia sư cần ảnh một trang PDF hay một hình SVG; tab vẽ rồi trả bằng `reader.rendered`, chờ tối đa 20 giây). Bảng dưới là thiết kế đầy đủ cho các bước sau.

**Đã có ở ER-2** (vẫn `WIRE_VERSION` 6, chỉ thêm method và field tùy chọn): `ReaderView` thêm `goal?`, `pass?`, `guideRev?`. `ReaderGuide { paperId, goal?, pass, passed, author: { state, task?, note?, error?, queued }, map: { has, roles, concepts (có mastery), notation, background, pretest, fivec? }, fivec?, summary?, units: ReaderUnitView[], misses, again, score, skipped }`; mỗi `ReaderUnitView` có `state` (waiting · preparing · ready · failed), câu dẫn, chỗ tự giải thích, hình, bảng che, `qalmri`, `points` (mở sau khi nhớ lại được chấm hay bỏ qua), câu hỏi (`ReaderItemView`, không có đáp án), các bài viết và điểm. Method: `reader.guide`, `reader.goal { goal, agentId? }`, `reader.pass { pass, done?, agentId? }`, `reader.answer { item, choice, confidence?, pretest? }` → `{ result?, guide }`, `reader.write { chatId?, kind, unit?, key?, text?, fields? }` → `{ id, graded, guide }`, `reader.skip { task }`, `reader.report { item, reason }`, `reader.author { action: "stop" | "retry" }`. `agentId` là agent bạn đang chọn, để chat ẩn dùng đúng agent khi chat gia sư chưa mở.

```ts
// protocol/src/reader.ts
ReaderView { paperId, title, goal?, pass: 1 | 2 | 3 | 4, doc: ReaderDocSummary, sections: { id, title, read, explained, checkpoint?: { right, total } }[],
             pending: { kind, id, title }[], concepts: { id, name, mastery }[], dueCards: number, preparing?: { task, done, total } }
ChatSnapshot.reader?: { paperId, title, pass, pending, preparing? }

Methods  reader.open { source: { arxiv } | { pdfPath } | { paperId } } → ReaderView
         reader.get · reader.doc (HTML/PDF và assets) · reader.goal · reader.pass
         reader.items { section } · reader.answer { item, choice, confidence } · reader.write { kind, section?, text }
         reader.widget { id } · reader.widgetCheck { id, ok, results, error? } · reader.report { item | widget, reason }
         reader.cards.due · reader.cards.review { card, grade } · reader.cards.keep { card, edit? }
         reader.page { page, png } (màn đọc gửi ảnh trang PDF agent cần)
Events   reader.updated { paperId } · chat.reader { chatId, reader }
```

### E.10 Giao diện

- **`ui/src/reader/`** (Preact, bundle mới `reader.js`, cùng `marked` + `KaTeX` + `DOMPurify` của ui): `app.tsx` (bố cục), `doc-html.tsx` (HTML arXiv; công thức vẽ bằng KaTeX từ `alttext` với `trust: false`, `maxExpand`, `maxSize` hữu hạn và macro của paper; KaTeX không vẽ được thì giữ MathML của LaTeXML, Chromium vẽ được MathML), `doc-pdf.tsx` (`pdfjs-dist` 6.5.438, đã thêm vào `ui`, bản dưới 4.2.67 dính CVE-2024-4367 chạy được JavaScript qua font trong PDF; 6.5 không còn biến hàm của PDF thành JavaScript nên cũng không còn tùy chọn `isEvalSupported`, và CSP của tab cấm eval; worker phải nạp bằng `fetch` URL tài nguyên → `Blob` → `new Worker(…, { type: "module" })` vì webview cấm worker từ URL tài nguyên khác origin, nên CSP của tab đọc có `connect-src <cspSource>` và `worker-src blob:`; VSIX nặng thêm ~1,75 MB; canvas + lớp chữ; mốc lưu cả câu trích, vị trí ký tự và số trang như Hypothesis), `outline.tsx`, `tools/` (ký hiệu, hình & bảng, câu hỏi của tôi, quiz, ví dụ tương tác, thẻ ôn), `selection.tsx` (thanh nổi khi chọn chữ), `widget-host.tsx` (Worker + iframe), `anchors.ts` (id → phần tử; câu trích → khoảng chữ, hàm thuần có test).
- **Khung chat**: `ui/src/reader-bar.tsx` như `mentor-bar.tsx`: thanh 4 lượt, việc đang chờ, nút "Hỏi tôi một câu", thẻ tiến độ soạn. `ui/src/chat-links.ts` vẽ `[[S3.SS2]]` / `[[p4: "…"]]` thành chip; bấm thì tab đọc cuộn tới và tô sáng.
- **`vscode/src/reader-host.ts`**: lệnh `ainb.reader.open` ("Easy Read: Mở paper…": link arXiv · file PDF · paper trong tủ), một tab editor cho mỗi paper (`retainContextWhenHidden`), phục vụ `doc.html`/assets/PDF qua `localResourceRoots` (thư mục của paper), chuyển `reader.*`. Tab đọc lên trước thì khung chat chuyển sang chat của paper đó (`PanelCore` thêm loại đích "reader", id dải riêng không trùng notebook VS Code hay tab Chrome).
- **Trang chủ Mentor**: thẻ paper trong Tủ paper có dòng "Đọc: lượt 2 · 3/7 mục · vững 64 %" và nút **Đọc tiếp**; thẻ Khởi động có thẻ ôn của paper.

### E.11 Chạm vào lõi ở đâu

Phần riêng (`bridge/src/reader/`, `ui/src/reader/`, `vscode/src/reader-*`) đứng một mình như Mentor. Chỗ đan vào lõi, nhỏ nhất có thể:

- `server.ts`: `chat.open` nhận đích reader (`readerSession`), handler `reader.*`, chat ẩn của người soạn/người kiểm (giống `authorChat`).
- `chat.ts`: chỉ `isNotebookTool` nhận `reader_*`. Không import gì từ `reader/` (giữ luật đang được test canh cho `mentor/`).
- `protocol/src/wire.ts`, `vscode/src/panel-core.ts` (`BRIDGE_METHODS`, đích reader), `vscode/src/extension.ts`, `bridge.ts` (chuyển `chat.reader`, `reader.updated`).
- Theo `AGENTS.md`: sửa các file trên thì chạy `pnpm --filter @ainb/bridge test mentor`; thêm `reader-contract.test.ts` ghim những gì reader đọc theo tên từ lõi (như `mentor-contract.test.ts`).

---

## F. Lộ trình và kiểm thử

### F.1 Các bước (mỗi dòng là một lần giao dùng được)

| Bước | Bạn dùng được | File chính |
|---|---|---|
| **ER-0 Thử kỹ thuật** ✓ (23/11/2026) | — (biên bản `docs/easy-read-er0.md`: HTML arXiv trên 16 paper; `srcdoc` + sandbox + nonce và Worker blob trong webview VS Code thật; pdf.js trong webview; chat không gắn notebook) | `bridge/test/debug/reader-arxiv-probe.mjs`, `bridge/test/reader-er0.test.ts`, `vscode/test/debug/reader-webview-probe/` |
| **ER-1 Đọc và hỏi** (code + test tự động xong 23/11/2026; chờ chạy thật F.3) | mở paper bằng link arXiv hoặc PDF; tab đọc có mục lục, công thức, hình; chọn đoạn → Giải thích / Ví dụ / Ký hiệu / Vì sao; gia sư trả lời có chip trích dẫn bấm được; câu hỏi của tôi và ghi chú; tiến độ đọc từng mục | `reader/ingest.ts`, `reader/chat.ts`, `reader/tools.ts`, `ui/src/reader/*`, `vscode/src/reader-host.ts`, `server.ts`, `panel-core.ts` |
| **ER-2 Lượt 1–2 có dẫn đường** (code + test tự động xong 24/11/2026; chờ chạy thật F.3) | chọn mục tiêu; lượt 1 (đoán trước, lướt có tô vai trò đoạn, tự viết 5C và được chấm, kiến thức nền, bảng ký hiệu); lượt 2 (câu dẫn, đọc hình, che kết quả để đoán, checkpoint: nhớ lại → tự giải thích → trắc nghiệm hai tầng có điểm độ chắc chắn, câu sai quay lại; phiếu QALMRI; tóm tắt cuối lượt); Sổ lỗi sai | `reader/author.ts`, `reader/checker.ts`, `reader/items.ts` + `reader/lint.ts` (kiểm E.6), `reader/model.ts` |
| **ER-3 Ví dụ tương tác** | widget cạnh công thức qua tự kiểm, đoán trước xem sau, "Thử điều này", so sánh hai cấu hình; nút yêu cầu widget từ đoạn đang chọn | `reader/widgets.ts`, `ui/src/reader/widget-host.tsx` |
| **ER-4 Đào sâu và ghi nhớ** | lượt 3 (dẫn lại công thức mờ dần, câu đào sâu chấm theo rubric, tìm chỗ sai, đồng nghiệp lề, review một trang, dựng lại sườn); lượt 4 (giải thích Feynman, thẻ ôn bạn duyệt/viết, ôn ngắt quãng ở Khởi động); tủ paper hiện tiến độ đọc; nút Reproduce sang xưởng | `reader/peer.ts`, `reader/cards.ts`, `reader/model.ts`, `mentor/papers.ts`, `ui/src/mentor/home.tsx` |
| **ER-5 Bối cảnh** | tài liệu tham khảo theo vai trò, paper trích dẫn nó, mở paper khác; lab Python từ widget trên notebook | `reader/related.ts`, `reader/lab.ts`, `MentorPlaces` |

Workflow `test` trên GitHub chạy `pnpm typecheck`, `pnpm build` và `pnpm test` (gồm cả bộ Mentor). Đóng gói và cài lại VSIX sau khi CI qua.

**ER-2 đã chốt khi làm** (khác hoặc cụ thể hơn thiết kế ở trên):

- Người soạn bắt đầu bản đồ khi bạn **chọn mục tiêu** (không phải ngay khi nạp), để mở paper chỉ để đọc không tốn agent. Bản đồ ghi từng phần (`reader_map_write`), phần nào qua kiểm hiện ngay.
- **Mục của lượt 2**: với HTML là các mục cấp 1 có số (bỏ abstract, phụ lục, tài liệu tham khảo, lời cảm ơn), kèm mục con; với PDF người soạn chia trang thành mục (`units` trong bản đồ). Checkpoint của hai mục đầu soạn khi vào lượt 2; mục kế tiếp soạn khi bạn vào mục trước nó. Mục không có gì để kiểm (related work, kết luận) có `light` và 0–2 câu.
- **Nhớ lại, tự giải thích, 5C, QALMRI, tóm tắt** đi sang khung chat như tin nhắn của bạn, kèm `<reader-grade>` (rubric + bản tham chiếu, chỉ có từ lúc này); gia sư chấm bằng `reader_grade`. Không mở chat gia sư thì bài được giữ và bản tham chiếu mở ngay. **Đọc hình** và **đoán bảng** không chấm: viết xong thì thấy thông điệp/kết quả tham chiếu.
- **Người kiểm** là một chat ẩn mới cho mỗi lô (đóng ngay sau), chỉ thấy câu hỏi đã xáo và các đoạn chứa câu trích; trả lời lệch hoặc thấy phương án khác cũng đúng thì câu trả về người soạn (`reader_items_fix`), tối đa hai lần, rồi bỏ. Câu người soạn không sửa thì bỏ luôn. Người kiểm không chạy được thì câu vẫn đến tay bạn, đánh dấu `unchecked`. Người kiểm dùng cùng agent và cấu hình với gia sư (quyết định 4).
- **Sổ lỗi sai**: câu sai với độ chắc ≥ 2 (đoán sai thì không), và hiểu sai gia sư ghi bằng `reader_misconception`, vào sổ của paper (thẻ Sổ lỗi sai của tab đọc) và sổ của Mentor (`misconception`, `attemptId "paper:<id>"`, tag `paper:<id>:<concept>`, kèm tên paper; Mentor hỏi lại sau 2 ngày như hiểu sai trong bài).
- Các bước sau bổ sung tooltip ký hiệu trong bản HTML, nút **Hỏi tôi một câu**, thanh lượt trong chat và ghi nhận ngày học của Mentor khi người đọc nộp bài, trả lời checkpoint hoặc ôn thẻ.
- Có thể chọn riêng Agent và Model cho Người kiểm ngay trong menu Agent của khung chat (`reader.settings`, lưu ở `reader.json`); vẫn hỗ trợ đặt `AINB_READER_CHECKER_MODEL` trước khi chạy bridge làm mặc định dự phòng. Có thể đặt `AINB_SEMANTIC_SCHOLAR_KEY` để tab Bối cảnh gọi Semantic Scholar.

### F.2 Kiểm thử tự động (không dùng agent thật, không mạng)

- `reader-ingest.test.ts`: HTML LaTeXML mẫu (lưu trong `test/fixtures/`) → `ReaderDoc`: mục lồng nhau, đoạn, công thức lấy đúng `alttext`, hình đổi sang đường dẫn cục bộ, script/style lạ bị bỏ; HTML hỏng thì rơi xuống LaTeX; dò id arXiv trong chữ trang đầu PDF.
- `reader-items.test.ts`: từng luật của E.6 (hai đáp án đúng, phương án "tất cả", câu trích không có trong paper, câu trích khác dấu/khoảng trắng vẫn khớp, trùng ý).
- `reader-model.test.ts`: `foldReader` (tiến độ mục, độ vững khái niệm, calibration, thang ôn thẻ, điều kiện "đã hiểu sâu"); nhật ký có sự kiện `r.*` vẫn đọc được bằng `fold` của Mentor (bỏ qua loại lạ), streak tính ngày đọc.
- `reader-chat.test.ts` (đầu-cuối với `fake-agent.mjs`): mở paper từ fixture → chat gia sư có `<reader-state>` → checkpoint đang chờ thì đáp án **không** có trong prompt của gia sư → trả lời xong thì có → người soạn ghi câu hỏi hỏng bị từ chối, câu đúng qua → người kiểm giải mù khác đáp án thì câu bị trả lại → không sự kiện nào của chat ẩn tới editor.
- `reader-contract.test.ts`: tên tool lõi và câu chữ mà reader dựa vào.
- `ui/test`: `anchors.ts` (câu trích → khoảng chữ trên HTML và trên lớp chữ PDF), chip trích dẫn, widget host (Worker bị dừng khi quá giờ; iframe không có `allow-same-origin`).

### F.3 Chạy thật (cần bạn)

1. Mở LoRA (`2106.09685`) bằng link: đủ mục, công thức, hình; hỏi một câu, bấm chip trích dẫn thì cuộn đúng chỗ.
2. Mở một PDF không có trên arXiv: đọc được, gia sư xin ảnh trang để đọc công thức.
3. Đi trọn lượt 1–2 trên DDPM (`2006.11239`): 5C, checkpoint, ít nhất hai widget (noise schedule, `q(x_t|x_0)`).
4. Lượt 3–4: câu đào sâu được chấm theo rubric, phản đối được một lần; thẻ ôn giữ lại hiện ở Khởi động sau 5 ngày (kiểm nhanh bằng ngày giả trong test, như các test lịch ôn của Mentor).
5. Bấm Reproduce: xưởng mở với đúng paper, không lấy lại nội dung.

Đợt nghiệm thu ngày 24/11/2026 dùng VS Code 1.147 và Claude ACP. Tab LoRA đã nhận trích dẫn đã kiểm từ gia sư. PDF cục bộ đã gửi ảnh trang cho gia sư qua `paper_page`. Trên DDPM, lượt thử đã nộp 5C, một checkpoint và tóm tắt, mở khóa hai widget sau câu dự đoán, chấm bài Đào sâu theo rubric, chấm lại một lần và đưa thẻ đã giữ vào Khởi động. CI giả lập ngày thứ năm để kiểm lịch ôn.

Đã bấm **Reproduce** trong lượt Đào sâu của LoRA trên VS Code. Xưởng LoRA xuất hiện trong bản sao của notebook Kaggle thử nghiệm và bridge ghi nhận đúng cặp paper–notebook. Nội dung HTML của paper được dùng lại từ bản đã lưu. Bridge lưu bản sao cell mẫu của Kaggle trước khi chép xưởng.

### F.4 Đo chất lượng nội dung do AI sinh

Sau khi soạn nội dung cho paper bằng bridge đang chạy, dùng `pnpm ainb reader eval <arxiv…>` để xem số liệu. Mặc định lệnh tra năm paper mốc Attention, LoRA, DDPM, ResNet và ViT. Thêm `--paper-quiz` để chạy một phiên ACP mới chỉ nhận bài học đã soạn và checkpoint đã qua người kiểm. Khi cần so prompt, chuẩn bị hai bộ nội dung ở hai hồ sơ `AINB_HOME` riêng để các lần đo dùng dữ liệu tương ứng.

- tỉ lệ câu hỏi qua từng phép kiểm ở E.6 (bao nhiêu câu bị chặn vì câu trích bịa, vì giải mù lệch, vì sai mức Bloom);
- widget qua tự kiểm sau ≤ 3 vòng;
- kiểu **PaperQuiz** (Paper2Web, Paper2Poster): một phiên agent mới chỉ được đọc bản đồ paper và các giải thích/widget đã sinh, rồi làm một bộ câu hỏi về paper do phiên khác soạn từ chính paper; điểm thấp nghĩa là nội dung sinh ra không chuyển được paper;
- khi dùng thật: tỉ lệ Báo câu sai, tỉ lệ "chắc mà sai" theo khái niệm, và tỉ lệ nhớ ở lần ôn thẻ đầu tiên.

PaperQuiz ngày 24/11/2026 dùng các checkpoint qua kiểm mù từ tối đa hai đơn vị học đầu tiên của mỗi paper.

| Paper | Câu đúng / tổng số |
|-------|-------------------:|
| Attention Is All You Need | 10/10 |
| LoRA | 10/10 |
| DDPM | 11/11 |
| ResNet | 8/8 |
| ViT | 7/7 |

Agent trả lời đủ 46 câu. Hai widget DDPM qua tự kiểm trong tổng cộng ba lượt kiểm.

---

## G. Rủi ro, giới hạn, quyết định

### G.1 Rủi ro và giới hạn đã biết

- Bridge xác nhận vị trí và nội dung câu trích. Người đọc có thể bấm chip để đối chiếu diễn giải và suy luận với ngữ cảnh đầy đủ. Người kiểm giải mù checkpoint và **Báo câu sai** rút câu bị phát hiện lỗi.
- **Chấm câu tự luận bằng AI không ổn định tuyệt đối.** Vì vậy điểm tự luận chỉ có 0/1/2 theo rubric, luôn kèm trích đúng câu chữ của bạn, và bạn có thể phản đối ("Mình nghĩ câu này đúng vì…") để gia sư chấm lại một lần.
- **Chi phí agent.** Bản đồ paper ~2–4 phút agent; mỗi mục một lô câu hỏi + một lượt kiểm; mỗi widget 1–3 vòng. Soạn trước một bước so với bạn để không tốn cho phần bạn không đọc tới.
- **HTML của arXiv** có thể lỗi ở paper dùng gói LaTeX lạ (bảng, thuật toán); khi đó tab đọc chuyển sang PDF, agent vẫn đọc LaTeX.
- **PDF không có arXiv**: chữ rút từ PDF làm vỡ công thức; agent phải xin ảnh trang để đọc, chậm hơn và tốn hơn.
- **Widget nặng**: ER-0 thấy frame sandbox chạy ở tiến trình riêng trên VS Code 1.147 (vòng lặp bận 1,5 s chỉ làm tab đọc khựng 43 ms), nên phần vẽ có lỗi không treo tab đọc; điều này phụ thuộc cách Chromium cách ly frame sandbox, có thể khác ở bản VS Code cũ. Phần tính vẫn được kiểm trong Worker có hẹn giờ, chủ yếu để bắt sai toán.
- **Không phải để học thay**: easy-read giúp bạn tự hiểu; nó không thay cho việc dẫn lại công thức trên giấy hay tự cài đặt (việc của xưởng Mentor).

### G.2 Ngoài phạm vi (lần này)

Đọc nhiều paper cùng lúc để so sánh (chỉ có "Bối cảnh" ở ER-5) · chia sẻ câu hỏi/thẻ giữa người dùng · paper không phải PDF hay arXiv (slide, blog) · đọc bằng giọng nói (podcast kiểu NotebookLM) · đồng bộ thẻ ôn sang Anki (có thể xuất file sau).

### G.3 Quyết định (đã chốt 23/11/2026: cả bảy theo đề xuất)

| # | Câu hỏi | Lựa chọn | Đề xuất và lý do |
|---|---|---|---|
| 1 | Easy-read nằm ở đâu | tab riêng, chung tủ paper với Mentor · nằm trong trang Mentor · tách hẳn, kho riêng | **Tab riêng, chung tủ paper**: đọc không cần notebook nên không nên bị kẹp trong luồng bài tập; nhưng một paper chỉ nên có một chỗ (đọc rồi reproduce, chung lịch ôn, chuỗi ngày, Sổ lỗi sai) |
| 2 | Giữ đáp án chặt tới đâu | mềm: việc đang chờ có nút "Cho xem luôn", ghi lại là đã bỏ qua, không tính tiến độ · cứng: phải làm mới mở · tắt | **Mềm**: đúng tinh thần "hỗ trợ tối đa" mà vẫn giữ mặc định là tự làm; bỏ qua có ghi lại nên tiến độ vẫn thật |
| 3 | Ngôn ngữ | giải thích và câu hỏi tiếng Việt, thuật ngữ + câu trích tiếng Anh · toàn tiếng Anh · cho chọn | **Tiếng Việt, giữ thuật ngữ và câu trích tiếng Anh** (như Mentor); câu hỏi viết đơn giản (ngôn ngữ đơn giản giúp người đọc không phải bản ngữ) |
| 4 | Agent của các chat ẩn | cùng agent và model với gia sư · model nhẹ hơn cho người soạn/người kiểm | **Một cấu hình chung: mọi vai theo gia sư** (agent, model và tùy chọn của chat gia sư). Bản trước cho người kiểm chọn agent/model riêng; đã bỏ để bạn chỉ quản một cấu hình và biết chắc agent nào đang tiêu tiền |
| 5 | PDF không có trên arXiv | pdf.js + ảnh trang cho agent (không cài gì) · thêm Marker/MinerU (Python, nặng, giấy phép có điều kiện) | **pdf.js + ảnh trang** trước; xem lại khi thấy công thức trong PDF là chỗ đau thật |
| 6 | Thuật toán ôn thẻ | lịch cố định kiểu Quantum Country · FSRS (`ts-fsrs`) | **Lịch cố định** trước (dễ hiểu, khớp cách Mentor đang hẹn ôn); đủ dữ liệu ôn thì cân nhắc FSRS |
| 7 | Thứ tự giao | ER-0 → 1 → 2 → 3 → 4 · đưa ví dụ tương tác (ER-3) lên trước câu hỏi (ER-2) | **ER-0 → 1 → 2 → 3 → 4**: câu hỏi và các lượt là xương sống; widget cần bản đồ paper (ER-2) để biết đặt ở đâu và minh họa khái niệm nào. Nếu bạn muốn thấy widget sớm, ER-3 có thể làm ngay sau ER-1 với widget theo yêu cầu (chưa tự đề xuất) |

Bảy quyết định đã được dùng cho triển khai. Biên bản ER‑0 ở `docs/easy-read-er0.md`.
