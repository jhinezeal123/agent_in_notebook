Viết **causal multi-head self-attention** của một mô hình GPT, dưới dạng một `nn.Module` tên `CausalSelfAttention`: mỗi vị trí chỉ được nhìn chính nó và các vị trí **đứng trước** nó, không bao giờ nhìn tương lai. Bài `gpt-mini` sau này ráp thẳng module này vào các khối Transformer.

Với một head (query, key, value của head đó là $Q, K, V$ shape $(T, d_h)$):

$$\text{head} = \operatorname{softmax}\!\left(\frac{QK^\top}{\sqrt{d_h}} + M\right)V, \qquad M_{ts} = \begin{cases} 0 & s \le t \\ -\infty & s > t \end{cases}$$

Các head được ghép lại rồi cho qua một phép chiếu đầu ra, như multi-head attention thường.

**`class CausalSelfAttention(nn.Module)`**, khởi tạo `CausalSelfAttention(n_embd, n_head)`, với $d_h$ = `n_embd // n_head`:

| thuộc tính | là gì |
|---|---|
| `qkv` | `nn.Linear(n_embd, 3 * n_embd)` (có bias): tạo $q$, $k$, $v$ của **mọi head** trong một phép nhân |
| `proj` | `nn.Linear(n_embd, n_embd)` (có bias): phép chiếu sau khi ghép các head |

Không có tham số hay buffer nào khác (máy chấm chép trọng số theo đúng tên `qkv.weight`, `qkv.bias`, `proj.weight`, `proj.bias`). Nếu `n_embd` không chia hết cho `n_head` thì `raise ValueError`.

**`forward(x)`**

- `x` shape `(B, T, C)` với `C = n_embd`. `T` đổi theo từng lần gọi (đừng cố định độ dài tối đa). Trả về tensor shape `(B, T, C)`.
- Đầu ra của `qkv(x)` có shape `(B, T, 3C)`: ba khối **liên tiếp** mỗi khối `C` feature, theo thứ tự $q$, $k$, $v$. Trong mỗi khối, head `i` (đếm từ 0) dùng các feature `i·d_h … (i+1)·d_h − 1`; ghép các head lại theo đúng thứ tự đó.
- Mask **tam giác dưới, gồm cả đường chéo**: vị trí `t` nhìn các vị trí `0..t`. Trọng số attention tới các vị trí sau `t` phải đúng bằng 0 và các trọng số còn lại cộng thành 1.
- Điểm attention chia cho $\sqrt{d_h}$.

Ràng buộc: tự viết công thức và tự dựng mask, **không** gọi `F.scaled_dot_product_attention` hay `nn.MultiheadAttention`; không vòng lặp Python theo head hay theo token (dùng `view`/`reshape`, `transpose`, `@`). Chưa cần dropout. Mask dựng trong `forward` theo `T`, không lưu trong `state_dict`.
