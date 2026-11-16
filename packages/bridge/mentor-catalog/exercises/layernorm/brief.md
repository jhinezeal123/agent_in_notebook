Viết `layer_norm(x, gamma, beta, eps=1e-5)`: chuẩn hoá `x` theo **trục cuối** (các feature của từng token), rồi scale và shift:

$$y = \gamma \odot \frac{x - \mu}{\sqrt{\sigma^2 + \epsilon}} + \beta, \qquad \mu = \frac{1}{d}\sum_k x_k,\quad \sigma^2 = \frac{1}{d}\sum_k (x_k - \mu)^2$$

- `x` có thể có shape `(N, d)` hoặc `(B, T, d)`; `gamma`, `beta` shape `(d,)`.
- Kết quả phải khớp `torch.nn.LayerNorm` (phương sai *không hiệu chỉnh*, ε nằm **trong** căn).
