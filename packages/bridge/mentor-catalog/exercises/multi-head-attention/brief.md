Viết `multi_head_attention(x, Wq, Wk, Wv, Wo, n_heads, causal=False)` trả về `(out, weights)`.

- `x` shape `(B, T, D)` với `D = d_model`; `Wq, Wk, Wv, Wo` shape `(D, D)`, quy ước **vector hàng** (nhân bên phải: `x @ Wq`), không có bias.
- `n_heads = H` phải chia hết `D`; nếu không, `raise ValueError`. Mỗi head có $d_h = D / H$ chiều.
- **Head `h` dùng các cột `h·d_h … (h+1)·d_h − 1`** của $Q = xW_q$, $K = xW_k$, $V = xW_v$:

$$Q_h = Q[:, :, h d_h : (h+1) d_h], \qquad A_h = \operatorname{softmax}\!\left(\frac{Q_h K_h^\top}{\sqrt{d_h}}\right), \qquad O_h = A_h V_h$$

$$\text{out} = \big[\,O_0 \;\|\; O_1 \;\|\; \cdots \;\|\; O_{H-1}\,\big]\; W_o$$

trong đó $\|$ là ghép theo trục feature, head 0 ở các cột đầu (đúng thứ tự cột như khi tách).

- `out` shape `(B, T, D)`; `weights` là các $A_h$ xếp lại, shape `(B, H, T, T)`, `weights[b, h, t, s]` = mức token `t` nhìn token `s` trong head `h`.
- `causal=True`: token `t` chỉ được nhìn các vị trí `s ≤ t` (trọng số tới tương lai bằng đúng 0, mỗi hàng vẫn cộng thành 1).
- Ổn định số với điểm lớn. Chỉ numpy, không vòng lặp Python theo head hay theo token (dùng reshape / transpose / `@`).
