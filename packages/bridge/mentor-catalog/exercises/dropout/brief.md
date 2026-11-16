Cài **inverted dropout** (kiểu PyTorch `nn.Dropout`): khi train, mỗi phần tử bị **bỏ** với xác suất $p$, độc lập với nhau, và phần tử được giữ thì được **phóng lên** $\frac{1}{1-p}$; khi eval thì không làm gì.

$$m_i \sim \operatorname{Bernoulli}(1-p), \qquad \text{out}_i = \frac{m_i\, x_i}{1-p}, \qquad \mathbb E[\text{out}_i] = x_i$$

1. `dropout_forward(x, p, rng, training=True)` trả về `(out, mask)`:
   - `x` shape bất kỳ; `rng` là `np.random.Generator`, mọi số ngẫu nhiên lấy từ nó.
   - `mask` là mảng **bool** cùng shape với `x`, `True` = phần tử được giữ.
   - `training=False`: `out` bằng `x` (giá trị y hệt), `mask` là `None`.
   - `p = 0`: `out` bằng `x`, `mask` toàn `True`. `p = 1`: `out` toàn 0, `mask` toàn `False`, không được ra `nan`.
   - `p` ngoài $[0, 1]$: raise `ValueError`.
2. `dropout_backward(grad_out, mask, p)` trả về $\partial L/\partial x$ (cùng shape `grad_out`), dùng đúng `mask` của forward. `mask` là `None` (eval) thì gradient đi qua nguyên vẹn. `p = 1` thì gradient bằng 0, không `nan`.

Không sửa `x` tại chỗ.
