Bài này ráp hai mảnh bạn đã viết thành thao tác chính của paper (§4.2, *Applying LoRA to Transformer*): lấy một **GPT đã có** (bài bạn đã viết `gpt-mini`) và **gắn LoRA vào** một số lớp tuyến tính của nó, đóng băng tất cả phần còn lại. Paper chỉ gắn vào các ma trận trong attention và để nguyên MLP; ở đây bạn chọn lớp nào được gắn bằng một danh sách tên.

Bài `lora-linear` của bạn đã định nghĩa `LoRALinear` và bài `gpt-mini` của bạn đã định nghĩa `GPT` (kèm `Block`, `CausalSelfAttention`): **dùng lại**, không viết lại.

**1. `add_lora(model, r, alpha, targets)`**

- `model`: một `GPT` của bạn. Mỗi phần tử của `model.blocks` là một `Block` có các lớp `nn.Linear` ở các đường dẫn `attn.qkv`, `attn.proj`, `mlp.0`, `mlp.2` (với `mlp` là một `nn.Sequential`, `mlp.0` là lớp con thứ 0).
- `targets`: danh sách các đường dẫn **tính từ mỗi khối**, ví dụ `["attn.qkv", "attn.proj"]`. Với **mỗi** khối trong `model.blocks` và **mỗi** đường dẫn trong `targets`, thay lớp `nn.Linear` ở đó bằng `LoRALinear(lớp đó, r, alpha)`. Mỗi chỗ gắn có `LoRALinear` **riêng**, với `A`, `B` riêng.
- Sau khi gắn, **chỉ các tham số `A` và `B`** của các `LoRALinear` mới vừa tạo được cần gradient. Mọi tham số khác của mô hình đều đóng băng: embedding, `LayerNorm`, `head`, các lớp Linear không nằm trong `targets` (cả bias), và trọng số gốc nằm trong các `LoRALinear`.
- Ngay sau khi gắn, mô hình phải cho **đúng cùng đầu ra** như trước khi gắn (vì mọi $B = 0$).
- Sửa `model` tại chỗ và **trả về chính `model` đó** (không phải một bản sao).

**2. `count_params(model)`** trả về một cặp số nguyên `(trainable, total)`:

- `trainable`: tổng số phần tử của các tham số đang cần gradient;
- `total`: tổng số phần tử của **mọi** tham số của mô hình (cả tham số đóng băng, cả `A`, `B` của adapter).

Mô hình gốc chưa gắn gì: `trainable = total`. Sau `add_lora`, tỷ lệ $100 \cdot \text{trainable} / \text{total}$ chính là "bao nhiêu phần trăm tham số được train" mà paper tự hào (với GPT-3 175B: giảm khoảng $10\,000$ lần số tham số cần train so với fine-tune toàn bộ). Một lớp `Linear(in, out)` được gắn LoRA hạng $r$ góp thêm $r\,(\text{in} + \text{out})$ tham số học được; các lớp đó cũng góp thêm đúng chừng ấy vào `total`.
