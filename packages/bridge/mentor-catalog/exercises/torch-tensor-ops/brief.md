Ba phản xạ numpy, giờ viết bằng PyTorch. Tensor đầu vào là `float32` (riêng `targets` là `int64`). Không dùng vòng lặp Python.

**1. `pairwise_sq_dists(x, y)`**: `x` shape `(N, D)`, `y` shape `(M, D)` → shape `(N, M)`:

$$D_{ij} = \lVert x_i - y_j \rVert^2 = \sum_{c} (x_{ic} - y_{jc})^2$$

Dùng broadcasting: thêm trục để hai tensor "gặp nhau" thành một tensor `(N, M, D)` rồi gộp trục cuối. Hàng `i` ứng với `x[i]`, cột `j` ứng với `y[j]`; `N` và `M` có thể khác nhau.

**2. `pick_logprobs(logits, targets)`**: `logits` shape `(..., C)`, `targets` shape `(...)` kiểu `int64`, giá trị trong `[0, C)` → shape `(...)`:

$$\text{out}[\dots] = \log \operatorname{softmax}\big(\text{logits}[\dots, :]\big)_{\text{targets}[\dots]}$$

Tức là log-xác suất mô hình gán cho lớp đúng (bằng −cross-entropy của từng mẫu).

- Phải chạy với cả `(B, C)` lẫn `(B, T, C)`: softmax luôn theo trục **cuối**.
- Ổn định số khi logits rất lớn (cỡ ±1000): kết quả phải hữu hạn.
- API nên dùng: `F.log_softmax`, `Tensor.gather` (để ý: index của `gather` phải có **cùng số chiều** với tensor nguồn).

**3. `batched_scores(q, k)`**: `q` shape `(B, H, T, d)`, `k` shape `(B, H, S, d)` → shape `(B, H, T, S)`:

$$\text{scores}_{bhts} = \frac{1}{\sqrt{d}} \sum_{c} q_{bhtc}\, k_{bhsc}$$

Viết bằng **một** lời gọi `torch.einsum` (rồi chia cho $\sqrt d$). Đây là attention scores của Transformer nhiều head: mỗi cặp (batch, head) độc lập, `T` truy vấn đối với `S` khoá.
