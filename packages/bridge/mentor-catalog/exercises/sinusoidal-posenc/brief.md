Viết `positional_encoding(T, d, base=10000.0)` trả về ma trận `PE` shape `(T, d)` (float) theo bài *Attention Is All You Need*: hàng `pos` là vector vị trí của token thứ `pos` (đếm **từ 0**), các cột đi theo **cặp** `(2i, 2i+1)` với cùng một tần số:

$$\omega_i = \frac{1}{\text{base}^{\,2i/d}}, \qquad PE[\text{pos},\, 2i] = \sin(\text{pos}\cdot\omega_i), \qquad PE[\text{pos},\, 2i+1] = \cos(\text{pos}\cdot\omega_i), \qquad i = 0, \dots, \tfrac{d}{2}-1$$

- Cột **chẵn** là sin, cột **lẻ** là cos, **xen kẽ** (không phải nửa đầu sin, nửa sau cos).
- `i` là chỉ số của **cặp**, không phải chỉ số cột: cột 0 và cột 1 cùng tần số $\omega_0 = 1$.
- `d` phải chẵn; nếu `d` lẻ, `raise ValueError`.
- `T ≥ 1`. Chỉ dùng numpy; làm được mà không cần vòng lặp Python.
