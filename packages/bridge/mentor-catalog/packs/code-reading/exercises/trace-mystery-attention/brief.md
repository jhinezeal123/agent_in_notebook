Đọc hàm ẩn danh `mystery_block_c(X, Wq, Wk, Wv)` trong cell **Code cho sẵn**, trong đó `X` có shape $(B, T, D)$ còn `Wq, Wk, Wv` đều có shape $(D, d)$.

Không gọi lại `mystery_block_c`, hãy tự suy luận và cài hai hàm:

1. `trace_shapes(B, T, D, d)`: trả về `dict` gồm 4 khóa `"Q"`, `"S"`, `"A"`, `"Y"` ánh xạ tới tuple shape tương ứng.
2. `predict_causal_weights(T, d)`: khi tất cả các điểm trước mask bằng nhau (ví dụ `Wq = 0` hoặc `Wk = 0`), trả về `dict` gồm:
   - `"A_uniform"`: ma trận shape $(T, T)$ dự đoán ma trận trọng số `A[b]` của mỗi mẫu trong batch.
   - `"upper_triangle_sum"`: số thực `float` dự đoán tổng mọi phần tử nằm chặt phía trên đường chéo chính ($j > i$) của `A[b]`.
   - `"scale_factor"`: số thực `float` hệ số nhân lên tích vô hướng $QK^\top$ trước khi che mask.
