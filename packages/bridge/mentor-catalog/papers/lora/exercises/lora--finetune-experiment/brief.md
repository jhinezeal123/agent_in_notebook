**Thí nghiệm cuối.** Bạn đã có `LoRALinear` và `add_lora`; giờ **fine-tune thật** và đo xem LoRA giữ lời hứa của paper: *train ít tham số hơn rất nhiều mà chất lượng vẫn gần fine-tune toàn bộ* (với GPT-3 175B: giảm khoảng $10\,000$ lần số tham số cần train và khoảng 3 lần bộ nhớ GPU, chất lượng ngang hoặc hơn fine-tune toàn bộ). Không làm lại được quy mô đó ở đây; bản thu nhỏ chạy vài phút trên CPU, **không cần Internet**: dữ liệu tự sinh.

**Cho sẵn** (phần "Cho sẵn của paper", bạn không phải viết): hai tác vụ trên bảng chữ cái 16 ký tự `a..p` (xem chú thích đầu phần cho sẵn): tác vụ **A** là "xoay vòng" `a→b→c→…→p→a`, tác vụ **B** giống A nhưng bốn quy tắc đổi chỗ (`c→k`, `j→d`, `f→n`, `m→g`); mỗi bước đúng quy tắc với xác suất 0,9, còn lại là ký tự ngẫu nhiên. Các hằng `VOCAB_SIZE`, `SEQ_LEN`, `LOSS_FLOOR` (loss nhỏ nhất có thể, vì nhiễu); `make_batch(task, n, generator)` sinh `n` chuỗi `(n, SEQ_LEN)` kiểu int64 của tác vụ `"A"` hoặc `"B"`; `to_text(seq)` đọc chuỗi ra chữ; `eval_loss(model, task)` đo loss trên chuỗi mới; và **`pretrain()`**: dựng một `GPT` (bài `gpt-mini` của bạn) cỡ nhỏ (khoảng 100 nghìn tham số), huấn luyện trước trên tác vụ A (khoảng 1 phút trên CPU) rồi trả về mô hình. Gọi `pretrain()` đúng **một lần** và để kết quả trong một biến (ví dụ `base`): nó cũng ghi một bản sao trọng số vào biến toàn cục `PRETRAINED_STATE` để máy chấm kiểm tra bạn đã dùng đúng mô hình đó.

**Việc của bạn: một cell code mà chạy xong thì có hai biến toàn cục:**

| biến | là gì |
|---|---|
| `model_full` | một `GPT` bắt đầu từ trọng số của `pretrain()`, rồi **fine-tune toàn bộ tham số** trên tác vụ B |
| `model_lora` | một `GPT` bắt đầu **cũng từ trọng số đó**, rồi gắn LoRA (`add_lora`, bài `lora--inject` của bạn) và chỉ fine-tune adapter trên tác vụ B |

Hai mô hình phải xuất phát từ cùng một bản trọng số nhưng là **hai đối tượng riêng** (không dùng chung tham số: nghĩ xem cách sao chép một `nn.Module`; bạn cần `import copy`). Cấu hình gợi ý, đủ để đạt ngưỡng (đổi được, miễn đúng ý):

| mục | giá trị |
|---|---|
| dữ liệu | mỗi bước một `make_batch("B", 64, gen)` với một `torch.Generator` có seed của bạn (batch mới mỗi bước, không có overfitting) |
| loss | cross-entropy dự đoán token kế: bạn đã có sẵn trong `GPT`: `model(x, x)` trả về `(logits, loss)` |
| `model_full` | Adam lr $10^{-3}$ trên **mọi** tham số, 300 bước |
| `model_lora` | `add_lora(..., r=4, alpha=8, targets=["attn.qkv", "attn.proj"])`, Adam lr $3\cdot10^{-3}$ chỉ trên các tham số đang cần gradient, 300 bước |

LoRA dùng learning rate **lớn hơn** vì chỉ có vài nghìn tham số mới, khởi đầu từ $B = 0$.

**Máy chấm không train lại cho bạn.** Chạy xong cell train thì bấm **Chấm bài**: máy chấm đọc `model_full` và `model_lora` đang sống trong kernel, sinh dữ liệu kiểm tra mới của tác vụ B (seed riêng) và báo:

- `lora_trainable_pct`: % tham số của `model_lora` đang cần gradient. **Đạt khi ≤ 10.**
- `loss_lora` và `loss_full`: loss trên dữ liệu kiểm tra của tác vụ B. **Mỗi số đạt khi ≤ 0,75** (so với `LOSS_FLOOR` ≈ 0,565 là mức không thể thắng).
- `loss_before`: loss của mô hình huấn luyện trước (trước khi fine-tune) trên tác vụ B (chỉ báo).
- `loss_ratio`: `loss_lora / loss_full` (chỉ báo; gần 1 nghĩa là LoRA ngang fine-tune toàn bộ).

Lưu ý: hai biến phải là biến toàn cục của kernel khi bấm Chấm bài (đừng đổi tên, đừng chạy lại cell "Code của bạn từ các bài trước" sau khi train: nó định nghĩa lại các class). Giữ mô hình trên CPU.
