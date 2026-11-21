Viết hai hàm `shannon_entropy(p)` và `kl_divergence(p, q)` tính **Shannon entropy** và **Kullback–Leibler divergence** (đơn vị nats, dùng log tự nhiên $\ln$) theo trục cuối `axis=-1`:

$$H(p) = -\sum_i p_i \ln p_i, \qquad D_{\mathrm{KL}}(p \parallel q) = \sum_i p_i \ln \frac{p_i}{q_i}.$$

**Quy ước ca biên (chuẩn lý thuyết thông tin):**
- $0 \ln 0 = 0$ và $0 \ln \frac{0}{q_i} = 0$ (kể cả khi $q_i = 0$).
- Nếu tồn tại vị trí có $p_i > 0$ và $q_i = 0$ thì $D_{\mathrm{KL}}(p \parallel q) = +\infty$ (`np.inf`).

**Shape vào / ra:**
- Vào: `p`, `q` là mảng xác suất không âm cùng shape `(..., K)` (hỗ trợ cả 1D `(K,)` và nhiều chiều `(B, K)`).
- Ra: mảng (hoặc scalar 0-D / float tương thích NumPy) có shape bằng `p.shape[:-1]`.
