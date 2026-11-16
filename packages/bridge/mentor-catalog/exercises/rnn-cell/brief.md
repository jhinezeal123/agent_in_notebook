Một RNN "vanilla" đọc chuỗi từng bước, mang theo trạng thái ẩn $h$:

$$h_t = \tanh\!\left(x_t W_x + h_{t-1} W_h + b\right), \qquad t = 1, \dots, T$$

Quy ước là **vector hàng** (giống `x @ W`): `Wx` shape `(d_in, d_h)`, `Wh` shape `(d_h, d_h)`, `b` shape `(d_h,)`.

1. `rnn_step(x_t, h_prev, Wx, Wh, b)`: `x_t` shape `(B, d_in)`, `h_prev` shape `(B, d_h)` → $h_t$ shape `(B, d_h)`.
2. `rnn_forward(x, h0, Wx, Wh, b)`: `x` shape **`(B, T, d_in)`** (batch trước, thời gian sau), `h0` shape `(B, d_h)` hoặc `None` (khi đó $h_0 = 0$). Trả về `(hs, h_last)`:
   - `hs` shape `(B, T, d_h)`, với `hs[:, t]` là trạng thái **sau** khi đọc `x[:, t]` (không chứa $h_0$);
   - `h_last` shape `(B, d_h)`, trạng thái sau bước cuối.
   - Chuỗi rỗng (`T = 0`): `hs` shape `(B, 0, d_h)` và `h_last` bằng $h_0$.
   - Không sửa `h0` tại chỗ.

Chỉ cần forward. Vòng lặp Python theo thời gian là bình thường (đó chính là bản chất tuần tự của RNN); trong mỗi bước thì tính cho cả batch cùng lúc.
