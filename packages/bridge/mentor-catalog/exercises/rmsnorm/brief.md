**Biến thể của LayerNorm.** RMSNorm (Zhang & Sennrich, 2019; dùng trong LLaMA, T5) bỏ hai thứ của LayerNorm: **không trừ trung bình** và **không có $\beta$**. Nó chỉ chia mỗi token cho căn của trung bình bình phương (root mean square) của token đó:

$$y = \gamma \odot \frac{x}{\sqrt{\operatorname{ms}(x) + \epsilon}}, \qquad \operatorname{ms}(x) = \frac{1}{d}\sum_{k=1}^{d} x_k^2$$

Viết `rms_norm(x, gamma, eps=1e-6)`:

- `x` có thể có shape `(N, d)` hoặc `(B, T, d)`; `gamma` shape `(d,)`; kết quả cùng shape với `x`.
- Thống kê lấy theo **trục cuối**, riêng cho từng token (như LayerNorm).
- ε nằm **trong** căn, cộng vào $\operatorname{ms}(x)$ (như `torch.nn.RMSNorm` và LLaMA).
- Token toàn số 0 phải ra số 0, không ra `nan`.
