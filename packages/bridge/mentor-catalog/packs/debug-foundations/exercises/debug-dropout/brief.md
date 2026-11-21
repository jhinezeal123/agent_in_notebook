Cell bài làm có sẵn hai hàm `dropout_forward(x, p, rng, training=True)` và `dropout_backward(grad_out, mask, p)` dùng **inverted dropout** (chuẩn của PyTorch/NumPy hiện đại).

**Triệu chứng:** Ở chế độ suy luận (`training=False`), hàm không giữ nguyên đầu vào mà nhân với $(1 - p)$; còn ở chế độ train, kỳ vọng của đầu ra bị tụt xuống $(1 - p) x$ thay vì giữ nguyên $x$.

**Việc của bạn:**
1. Chạy Phòng công thức xem kỳ vọng ở chế độ train và giá trị ở chế độ eval.
2. Ghi giả thuyết vào cell Phác thảo.
3. Sửa cả `dropout_forward` và `dropout_backward` theo đúng inverted dropout (nhớ xử lý ca biên $p = 1.0$).
