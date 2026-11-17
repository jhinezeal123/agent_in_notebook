Ráp một **lớp encoder** (§3.1, Figure 1 bên trái): hai sublayer nối tiếp, đầu tiên là self-attention, sau đó là một mạng feed-forward áp riêng cho từng vị trí. Quanh **mỗi** sublayer có residual connection, dropout và LayerNorm kiểu **post-LN** như paper. Bài `attention--mha` của bạn đã định nghĩa `MultiHeadAttention`: dùng lại.

Paper viết (§3.1, §5.4): đầu ra của mỗi sublayer là $\operatorname{LayerNorm}(x + \operatorname{Sublayer}(x))$, trong đó *"we apply dropout to the output of each sub-layer, before it is added to the sub-layer input and normalized"*. Mạng feed-forward (§3.3, Eq. 2):

$$\operatorname{FFN}(x) = \max(0,\ xW_1 + b_1)\,W_2 + b_2$$

**`class FeedForward(nn.Module)`**, khởi tạo `FeedForward(d_model, d_ff)`:

| thuộc tính | là gì |
|---|---|
| `w1` | `nn.Linear(d_model, d_ff)`: $W_1, b_1$ |
| `w2` | `nn.Linear(d_ff, d_model)`: $W_2, b_2$ |

`forward(x)`: `x` shape `(B, T, d_model)` → `(B, T, d_model)`. Không có dropout bên trong.

**`class EncoderLayer(nn.Module)`**, khởi tạo `EncoderLayer(d_model, n_heads, d_ff, dropout=0.1)`:

| thuộc tính | là gì |
|---|---|
| `self_attn` | `MultiHeadAttention(d_model, n_heads)` (của bạn) |
| `ffn` | `FeedForward(d_model, d_ff)` |
| `norm1`, `norm2` | `nn.LayerNorm(d_model)`, tham số mặc định: một cái cho mỗi sublayer, không dùng chung |
| `drop` | `nn.Dropout(dropout)`, dùng cho cả hai sublayer |

Máy chấm chép trọng số theo đúng các tên này (ví dụ `self_attn.w_q.weight`, `ffn.w1.bias`, `norm1.weight`), nên không thêm tham số nào khác.

**`forward(x, src_mask=None)`**: `x` shape `(B, S, d_model)`; `src_mask` là tensor bool broadcast được tới `(B, n_heads, S, S)`, **`True` = được nhìn** (thường là mask padding `(B, 1, 1, S)`). Sublayer 1 là self-attention (`q = k = v = x`, có mask), sublayer 2 là `ffn`. Trả về shape `(B, S, d_model)`.

Ràng buộc: `nn.Dropout` chỉ làm việc khi module ở chế độ train (không tự gọi `F.dropout` với `training=True` cố định). Dropout chỉ đặt ở đầu ra từng sublayer, không đặt trong attention hay trong `FeedForward`.
