Ráp một **GPT thu nhỏ** từ các mảnh đã có: embedding của token, embedding của vị trí, một chồng khối Transformer, LayerNorm cuối và lớp ra chữ (lm head). Bạn viết hai class: `Block` (một khối) và `GPT` (cả mô hình). Bài `causal-attention` của bạn đã định nghĩa `CausalSelfAttention` ở phía trên: **dùng lại** nó trong `Block`, không viết lại attention.

**`class Block(nn.Module)`**, khởi tạo `Block(n_embd, n_head)`, là khối **pre-LN**: LayerNorm đứng *trước* mỗi nhánh con, và mỗi nhánh con được cộng vào đường residual.

$$x \leftarrow x + \operatorname{Attn}\big(\operatorname{LN}_1(x)\big), \qquad x \leftarrow x + \operatorname{MLP}\big(\operatorname{LN}_2(x)\big)$$

| thuộc tính | là gì |
|---|---|
| `ln1`, `ln2` | `nn.LayerNorm(n_embd)` |
| `attn` | `CausalSelfAttention(n_embd, n_head)` |
| `mlp` | một `nn.Sequential` gồm đúng ba lớp: `nn.Linear(n_embd, 4 * n_embd)`, `nn.GELU()`, `nn.Linear(4 * n_embd, n_embd)` |

`forward(x)`: `x` shape `(B, T, C)`, trả về cùng shape.

**`class GPT(nn.Module)`**, khởi tạo `GPT(vocab_size, block_size, n_embd, n_head, n_layer)`:

| thuộc tính | là gì |
|---|---|
| `block_size` | số nguyên: độ dài tối đa của chuỗi mà mô hình nhận |
| `tok_emb` | `nn.Embedding(vocab_size, n_embd)`: embedding của token |
| `pos_emb` | `nn.Embedding(block_size, n_embd)`: embedding **học được** của vị trí `0 … block_size − 1` |
| `blocks` | `n_layer` khối `Block(n_embd, n_head)` xếp liền nhau, trong một `nn.ModuleList` (hoặc `nn.Sequential`) |
| `ln_f` | `nn.LayerNorm(n_embd)`: LayerNorm cuối, sau khối cuối cùng |
| `head` | `nn.Linear(n_embd, vocab_size, bias=False)`: ra logits trên từ vựng |

Không có tham số hay buffer nào khác (máy chấm chép trọng số theo tên tham số). Không cần dropout.

**`forward(idx, targets=None)`** trả về **`(logits, loss)`**:

- `idx` shape `(B, T)` kiểu số nguyên, `1 ≤ T ≤ block_size`; `T` đổi theo từng lần gọi, không nhất thiết bằng `block_size`. Vị trí của token thứ `t` trong chuỗi là `t`.
- Đầu vào của khối đầu tiên là tổng embedding của token và embedding của vị trí. `logits` shape `(B, T, vocab_size)`: `logits[b, t]` là điểm của từng token cho **token đứng ngay sau** vị trí `t`.
- `targets` (không bắt buộc) là tensor số nguyên shape `(B, T)`: `targets[b, t]` là token thật ở vị trí `t` của chuỗi (khi huấn luyện, thường `targets` chính là `idx`). Mô hình dự đoán token ở vị trí `t + 1` từ các vị trí đến `t`, nên loss là cross-entropy **trung bình** trên mọi cặp (đầu ra ở `t`, token thật ở `t + 1`) với $t = 0 \dots T-2$ và mọi mẫu trong batch:

$$\mathcal{L} = -\frac{1}{B\,(T-1)} \sum_{b=1}^{B} \sum_{t=0}^{T-2} \log \operatorname{softmax}\big(\text{logits}_{b,t}\big)\big[\,\text{targets}_{b,t+1}\,\big]$$

  Đầu ra ở vị trí cuối không có token nào để dự đoán trong chuỗi này, và token đầu tiên không do vị trí nào dự đoán.
- Không có `targets` thì `loss` là `None`.

Ràng buộc: `loss` là một số (tensor 0 chiều), tính bằng một lần `F.cross_entropy` trên **logits** (không phải xác suất). Test dùng `B > 1`, nên hãy cẩn thận khi bạn duỗi các tensor đã cắt lát theo thời gian thành `(N, ·)`. Không vòng lặp Python theo token hay theo batch (vòng lặp qua các khối thì được).
