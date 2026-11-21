Cell bài làm có sẵn hai hàm `log_softmax(z, axis=-1)` và `cross_entropy(logits, targets)`.

**Triệu chứng:** Trên logits nhỏ trong khoảng $[-5, 5]$, cả hai hàm cho kết quả đúng. Nhưng khi logits tăng lên khoảng $1000$ hoặc giảm xuống $-1000$, `log_softmax` và `cross_entropy` lập tức nổ thành `NaN` hoặc `inf`.

**Việc của bạn:**
1. Chạy Phòng công thức xem ngưỡng tràn số của `np.exp`.
2. Nêu giả thuyết về nguyên nhân tràn số / underflow trong cell Phác thảo.
3. Sửa `log_softmax(z, axis=-1)` và `cross_entropy(logits, targets)` để ổn định số với mọi biên độ logits và mọi `axis`.
