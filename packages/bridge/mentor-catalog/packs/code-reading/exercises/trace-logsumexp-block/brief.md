Đọc hàm ẩn danh `mystery_block_b(Z, tau)` trong cell **Code cho sẵn** (với `Z` shape $(B, K)$ và nhiệt độ `tau > 0`).

Không gọi lại `mystery_block_b`, hãy tự suy luận và cài hai hàm:

1. `trace_shapes(B, K)`: trả về `dict` gồm 4 khóa `"m"`, `"lse"`, `"P"`, `"H"` ánh xạ tới tuple shape tương ứng.
2. `predict_behavior(B, K, tau, shift)`: với `B >= 1`, `K >= 2`, `tau > 0` và số thực `shift`, trả về `dict` gồm:
   - `"lse_shift_delta"`: số thực `float` cho biết `lse(Z + shift, tau) - lse(Z, tau)` tăng đúng bao nhiêu (dấu đầy đủ).
   - `"P_row_sums"`: mảng shape $(B,)$ dự đoán `P.sum(axis=-1)`.
   - `"H_constant_Z"`: mảng shape $(B,)$ dự đoán giá trị của `H` khi mọi phần tử trên mỗi hàng của `Z` bằng nhau.
