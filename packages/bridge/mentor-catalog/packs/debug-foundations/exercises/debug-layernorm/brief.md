Cell bài làm có sẵn hàm `layer_norm(x, gamma, beta, eps=1e-5)` chuẩn hóa theo trục cuối cùng của `x`.

**Triệu chứng:** Với các vector đầu vào có phương sai cỡ $1$, kết quả khớp tới $10^{-5}$. Nhưng khi kiểm tra với phương sai rất nhỏ (hoặc với `eps` lớn hơn để phóng đại sai số), giá trị lệch đáng kể so với công thức chuẩn $y = \gamma \odot \frac{x - \mu}{\sqrt{\sigma^2 + \varepsilon}} + \beta$.

**Việc của bạn:**
1. Chạy Phòng công thức so sánh hai cách đặt $\varepsilon$ khi phương sai nhỏ dần về $0$.
2. Ghi giả thuyết vào cell Phác thảo.
3. Sửa `layer_norm(x, gamma, beta, eps=1e-5)` cho khớp công thức chuẩn trên mọi shape (2D, 3D) và ca biên hàng hằng số.
