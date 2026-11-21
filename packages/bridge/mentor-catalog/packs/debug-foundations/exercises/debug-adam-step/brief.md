Cell bài làm có sẵn hai hàm `adam_init(params)` và `adam_step(params, grads, state, lr=1e-3, b1=0.9, b2=0.999, eps=1e-8)`.

**Triệu chứng:** Sau hàng nghìn bước thì cập nhật có vẻ gần đúng, nhưng ở bước $t = 1$ với gradient hằng số $g = 1$, độ lớn bước cập nhật $|\Delta p|$ chỉ khoảng $3.16 \times \text{lr}$ thay vì xấp xỉ đúng $\text{lr}$ như Adam chuẩn!

**Việc của bạn:**
1. Chạy Phòng công thức so sánh độ lớn bước cập nhật ở các bước $t = 1, 2, \dots, 20$.
2. Nêu giả thuyết về nguyên nhân sai lệch ở giai đoạn đầu trong cell Phác thảo.
3. Sửa `adam_step` để khớp chính xác thuật toán Adam (bao gồm hiệu chỉnh độ lệch khởi tạo tại $0$).
