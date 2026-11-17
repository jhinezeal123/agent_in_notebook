Ráp một **lớp decoder** (§3.1, Figure 1 bên phải): giống lớp encoder nhưng có **ba** sublayer. Sublayer thêm vào là **cross-attention**, nơi decoder nhìn sang đầu ra của encoder. Bài `attention--mha` và bài `attention--encoder-layer` của bạn đã định nghĩa `MultiHeadAttention` và `FeedForward`: dùng lại.

Paper (§3.1, §3.2.3):

- sublayer 1: **masked self-attention** trên chuỗi đích. Mask không cho vị trí $t$ nhìn các vị trí sau $t$, để lúc sinh từng token ta không "nhìn trộm" đáp án;
- sublayer 2: **encoder-decoder attention**. *"The queries come from the previous decoder layer, and the memory keys and values come from the output of the encoder."*;
- sublayer 3: mạng feed-forward theo vị trí.

Quanh mỗi sublayer vẫn là $\operatorname{LayerNorm}(x + \operatorname{Dropout}(\operatorname{Sublayer}(x)))$, như ở bài encoder.

**`class DecoderLayer(nn.Module)`**, khởi tạo `DecoderLayer(d_model, n_heads, d_ff, dropout=0.1)`:

| thuộc tính | là gì |
|---|---|
| `self_attn` | `MultiHeadAttention(d_model, n_heads)` (của bạn) cho sublayer 1 |
| `cross_attn` | một `MultiHeadAttention(d_model, n_heads)` **khác** (tham số riêng) cho sublayer 2 |
| `ffn` | `FeedForward(d_model, d_ff)` (của bạn) |
| `norm1`, `norm2`, `norm3` | `nn.LayerNorm(d_model)`, một cái cho mỗi sublayer |
| `drop` | `nn.Dropout(dropout)` |

Máy chấm chép trọng số theo đúng các tên này, nên không thêm tham số nào khác.

**`forward(x, memory, tgt_mask=None, memory_mask=None)`**:

- `x` shape `(B, T, d_model)`: chuỗi đích (đã qua embedding hoặc lớp decoder trước);
- `memory` shape `(B, S, d_model)`: đầu ra của encoder; `S` có thể khác `T`;
- `tgt_mask`: bool, broadcast được tới `(B, n_heads, T, T)`, `True` = được nhìn; mask causal `(T, T)` là dạng hay gặp;
- `memory_mask`: bool, broadcast được tới `(B, n_heads, T, S)`; thường là mask padding của câu nguồn `(B, 1, 1, S)`;
- trả về shape `(B, T, d_model)`.

Mỗi mask chỉ dùng ở đúng sublayer của nó. Tên tham số `tgt_mask` và `memory_mask` cố định để bài `Transformer` sau này gọi được.
