**Biến thể của scaled dot-product attention.** Thêm một **nhiệt độ** $\tau > 0$ chia vào điểm, ngoài phép chia $\sqrt{d_k}$:

$$\text{weights} = \operatorname{softmax}\!\left(\frac{QK^\top}{\tau\,\sqrt{d_k}} \;\text{(các vị trí bị che} \to -\infty)\right), \qquad \text{out} = \text{weights}\, V$$

Viết `attention_temp(Q, K, V, tau=1.0, mask=None)` trả về `(out, weights)`:

- Shape như bài trước: `Q` `(..., T, d_k)`, `K` `(..., S, d_k)`, `V` `(..., S, d_v)`; `weights` `(..., T, S)`, `out` `(..., T, d_v)`.
- `mask` (nếu có) là mảng bool broadcast được về `(..., T, S)`: `True` = được nhìn, `False` = bị che. Mỗi hàng có ít nhất một vị trí `True`. Vị trí bị che phải có trọng số **đúng bằng 0** với mọi τ.
- $\tau = 1$ cho đúng attention của bài trước.
- **Ổn định số** cả khi τ rất nhỏ (ví dụ `1e-4`, điểm bị nhân lên cả vạn lần) lẫn rất lớn (ví dụ `1e6`).
