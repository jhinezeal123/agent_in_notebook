Cell bài làm có sẵn hàm `rms_norm(x, gamma, eps=1e-6)` cài đặt RMSNorm theo trục cuối:
$$\operatorname{RMSNorm}(x) = \gamma \odot \frac{x}{\sqrt{\frac{1}{D}\sum_{i=1}^D x_i^2 + \varepsilon}}.$$

**Triệu chứng:** Khi đưa vào một token hằng số khác 0 (ví dụ $x = [3, 3, 3, 3]$), đầu ra bị kéo hết về $0$ thay vì xấp xỉ $\gamma$; trung bình theo trục cuối luôn bị ép về $0$ giống LayerNorm.

**Việc của bạn:**
1. Chạy Phòng công thức so sánh tác động lên vector có dịch chuyển hằng số.
2. Nêu giả thuyết trong cell Phác thảo.
3. Sửa `rms_norm(x, gamma, eps=1e-6)` cho đúng bản chất RMSNorm trên cả 2D và 3D.
