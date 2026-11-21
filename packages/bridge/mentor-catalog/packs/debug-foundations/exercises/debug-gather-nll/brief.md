Cell bài làm có sẵn hàm `masked_nll(log_probs, targets, mask)` tính negative log-likelihood trung bình trên các vị trí có `mask == 1`, với `log_probs` shape $(B, T, V)$, `targets` shape $(B, T)$, `mask` shape $(B, T)$.

**Triệu chứng:** Khi thêm nhiều token padding (`mask == 0`) vào cuối câu trong batch mà không đổi nội dung thật, giá trị loss giảm mạnh một cách giả tạo; ngoài ra cần xử lý an toàn khi toàn bộ mask đều bằng 0 (trả về `0.0`).

**Việc của bạn:**
1. Chạy Phòng công thức xem loss thay đổi thế nào theo tỉ lệ padding.
2. Nêu giả thuyết trong cell Phác thảo.
3. Sửa `masked_nll(log_probs, targets, mask)` cho đúng mẫu số và ca biên mask toàn 0.
