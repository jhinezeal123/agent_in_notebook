Viết **multi-head attention** đúng như paper (§3.2.1–3.2.2, Eq. 1, Figure 2), dưới dạng một `nn.Module` mà các bài sau dùng lại cho cả self-attention lẫn cross-attention.

Paper viết (Eq. 1 và §3.2.2):

$$\operatorname{Attention}(Q, K, V) = \operatorname{softmax}\!\left(\frac{QK^\top}{\sqrt{d_k}}\right)V$$

$$\operatorname{MultiHead}(Q, K, V) = \operatorname{Concat}(\text{head}_1, \dots, \text{head}_h)\,W^O, \qquad \text{head}_i = \operatorname{Attention}(QW_i^Q,\ KW_i^K,\ VW_i^V)$$

với $d_k = d_v = d_\text{model}/h$.

**`class MultiHeadAttention(nn.Module)`**, khởi tạo `MultiHeadAttention(d_model, n_heads)`:

| thuộc tính | là gì |
|---|---|
| `w_q`, `w_k`, `w_v` | `nn.Linear(d_model, d_model)` (có bias): phép chiếu của **mọi head gộp lại** |
| `w_o` | `nn.Linear(d_model, d_model)` (có bias): $W^O$ |

Không có tham số nào khác (máy chấm chép trọng số theo đúng các tên `w_q.weight`, `w_q.bias`, …). Nếu `d_model` không chia hết cho `n_heads` thì `raise ValueError`.

**`forward(q, k, v, mask=None)`**:

- `q` shape `(B, Tq, d_model)`; `k`, `v` shape `(B, Tk, d_model)`. Self-attention là `q = k = v = x`; cross-attention thì `Tq` và `Tk` có thể khác nhau.
- Head `i` (đếm từ 0) dùng các feature `i·d_k … (i+1)·d_k − 1` của `w_q(q)`, `w_k(k)`, `w_v(v)`. Ghép các head lại theo đúng thứ tự đó (head 0 ở các feature đầu) rồi cho qua `w_o`.
- `mask`: tensor **bool**, broadcast được tới shape của điểm attention `(B, n_heads, Tq, Tk)`. **`True` = được nhìn**, `False` = bị che (trọng số attention tới key đó phải đúng bằng 0). Hai dạng hay gặp: mask padding `(B, 1, 1, Tk)` và mask causal `(Tq, Tk)`.
- Trả về tensor shape `(B, Tq, d_model)`.

Ràng buộc: tự viết công thức, **không** gọi `F.scaled_dot_product_attention` hay `nn.MultiheadAttention`; không vòng lặp Python theo head hay theo token (dùng `view`/`reshape`, `transpose`, `@`). Chưa cần dropout trong bài này.
