Cell bài làm có sẵn hàm `attention(Q, K, V, mask=None)` tính scaled dot-product attention $\operatorname{softmax}\left(\frac{QK^\top}{\sqrt{d_k}}\right) V$ và trả về `(out, weights)`.

**Triệu chứng:** Khi `mask=None`, kết quả khớp hoàn toàn. Nhưng khi truyền `mask` (ví dụ causal mask tam giác dưới), tổng trọng số trên các hàng đầu nhỏ hơn $1$ rất nhiều (hàng đầu tiên có thể chỉ còn $0.25$ thay vì $1.0$).

**Việc của bạn:**
1. Chạy Phòng công thức quan sát tổng trọng số mỗi hàng khi có causal mask.
2. Ghi giả thuyết vào cell Phác thảo.
3. Sửa `attention(Q, K, V, mask=None)` sao cho mask tác động đúng chỗ và tổng trọng số mỗi hàng luôn bằng 1.
