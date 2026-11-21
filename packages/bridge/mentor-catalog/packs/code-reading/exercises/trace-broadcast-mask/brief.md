Đọc hàm ẩn danh `mystery_block_a(X, mask)` trong cell **Code cho sẵn** (với `X` shape $(B, T, D)$ và `mask` boolean shape $(B, T)$ có ít nhất một `True` mỗi dòng).

Không gọi lại `mystery_block_a`, hãy tự suy luận và cài hai hàm:

1. `trace_shapes(B, T, D)`: trả về `dict` gồm 4 khóa `"w"`, `"mu"`, `"R"`, `"out"` ánh xạ tới tuple shape của 4 biến trung gian/đầu ra tương ứng.
2. `predict_invariants(X, mask, shift)`: với `X` shape $(B, T, D)$, `mask` shape $(B, T)$ (mỗi hàng có ít nhất một `True`), và `shift` shape $(B, 1, D)$, trả về `dict` gồm:
   - `"sum_R_over_T"`: mảng shape $(B, D)$ dự đoán giá trị của `R.sum(axis=1)`.
   - `"masked_R_max_abs"`: số thực `float` dự đoán giá trị lớn nhất của `|R|` tại các vị trí `mask == False`.
   - `"out_shift_diff"`: số thực `float` dự đoán sai khác lớn nhất `max(|out(X + shift) - out(X)|)` khi cộng `shift` theo từng $(b, d)$ lên toàn bộ chuỗi $T$.
