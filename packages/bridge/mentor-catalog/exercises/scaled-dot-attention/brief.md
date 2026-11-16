Viết `attention(Q, K, V, mask=None)` trả về `(out, weights)`:

$$\text{weights} = \operatorname{softmax}\!\left(\frac{QK^\top}{\sqrt{d_k}} \;\text{(các vị trí bị che} \to -\infty)\right), \qquad \text{out} = \text{weights}\, V$$

- `Q` shape `(..., T, d_k)`, `K` shape `(..., S, d_k)`, `V` shape `(..., S, d_v)`; `...` là các trục batch/head bất kỳ.
- `weights` shape `(..., T, S)`, `out` shape `(..., T, d_v)`.
- `mask` (nếu có) là mảng bool broadcast được về `(..., T, S)`: `True` = được nhìn, `False` = bị che. Mỗi hàng có ít nhất một vị trí `True`.
- Ổn định số với điểm lớn.
