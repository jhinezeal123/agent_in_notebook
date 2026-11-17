**Thí nghiệm cuối.** Bạn đã dựng xong Transformer; giờ **train** nó và đo xem nó có học được không. Paper train trên WMT14 dịch Anh–Đức (BLEU 28.4, hàng triệu câu, 8 GPU trong nhiều ngày): không làm nổi ở đây. Bản thu nhỏ: "dịch" **đảo ngược một chuỗi 8 chữ số**, ví dụ `3 1 4 1 5 9 2 6` → `6 2 9 5 1 4 1 3`, bằng một mô hình cỡ 200 nghìn tham số, train vài phút trên GPU của Kaggle. Cùng kiến trúc, cùng công thức train, chỉ khác quy mô.

**Cho sẵn** (phần "Cho sẵn của paper", bạn không phải viết): các hằng `PAD`, `BOS`, `EOS`, `VOCAB_SIZE` và `SEQ_LEN` (bằng 8); `make_batch(n, length, generator)` sinh `n` chuỗi ngẫu nhiên kèm `src`, `tgt_in = [BOS, đảo...]`, `tgt_out = [đảo..., EOS]` (đều int64); `greedy_decode(model, src, max_len)` để sinh đáp án; `to_text(tokens)` để đọc ra chữ. Không có tập dữ liệu cố định: mỗi bước train bạn gọi `make_batch` lấy một batch **mới**, nên không có overfitting.

**Việc của bạn: một cell code chạy xong thì biến toàn cục `model` là một `Transformer` của bạn (bài `attention--transformer`) đã train.** Cấu hình gợi ý, đủ để đạt ngưỡng (đổi được, miễn mô hình là `Transformer` của bạn):

| mục | giá trị |
|---|---|
| mô hình | `Transformer(VOCAB_SIZE, d_model=64, n_heads=4, d_ff=128, n_layers=2, dropout=0.1)` |
| dữ liệu | mỗi bước một `make_batch` cỡ 128, độ dài `SEQ_LEN`, với một `torch.Generator` có seed của bạn |
| thiết bị | GPU nếu notebook bật GPU (Settings → Accelerator), không thì CPU; mô hình và mỗi batch phải nằm cùng một thiết bị |
| số bước | 4000 (vài phút trên GPU Kaggle; trên CPU lâu hơn nhiều, cỡ 10 phút trở lên) |
| optimizer | Adam với $\beta_1 = 0.9,\ \beta_2 = 0.98,\ \epsilon = 10^{-9}$ (§5.3) |
| learning rate | Eq. 3, §5.3: $\text{lrate} = d_\text{model}^{-0.5}\cdot\min\!\left(\text{step}^{-0.5},\ \text{step}\cdot\text{warmup\_steps}^{-1.5}\right)$ với `warmup_steps = 400`, `step` đếm từ 1, nhân thêm hệ số 0.5 (mô hình nhỏ hơn bản gốc nhiều lần, lr đỉnh cỡ $3\cdot10^{-3}$) |
| loss | cross-entropy giữa logits và `tgt_out`, label smoothing $\epsilon_{ls} = 0.1$ (§5.4) |

**Máy chấm không train lại cho bạn.** Chạy xong cell train thì bấm **Chấm bài**: máy chấm đọc `model` đang sống trong kernel, sinh 512 chuỗi mới (seed riêng, mô hình chưa từng thấy) rồi dùng `greedy_decode` giải và báo ba con số:

- `token_acc`: tỷ lệ token đúng trong 9 vị trí (8 chữ số đảo và `EOS`). **Đạt khi ≥ 0.9.**
- `exact_match`: tỷ lệ chuỗi đảo đúng hoàn toàn (chỉ báo, không có ngưỡng).
- `token_acc_len12`: như `token_acc` nhưng trên chuỗi **dài 12**, dài hơn mọi chuỗi lúc train (chỉ báo, để đối chiếu với dự đoán của bạn).

Lưu ý: `model` phải là biến toàn cục của kernel khi bấm Chấm bài (đừng đổi tên, đừng chạy lại cell "Code của bạn từ các bài trước" sau khi train: nó định nghĩa lại các class). `greedy_decode` tự đưa mô hình về chế độ eval khi giải.
