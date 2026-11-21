Cell bài làm có sẵn hàm `multi_head_attention(x, Wq, Wk, Wv, Wo, n_heads, causal=False)` nhận `x` shape $(B, T, D)$ và trả về `(out, weights)`.

**Triệu chứng:** Với `n_heads = 1`, hàm chạy hoàn toàn đúng! Nhưng khi `n_heads > 1`, đầu ra sai hoàn toàn: mỗi head không đọc đúng dải cột $d_h = D / H$ của từng token mà lại trộn lẫn các token khác nhau dọc theo trục thời gian $T$.

**Việc của bạn:**
1. Chạy Phòng công thức quan sát sự khác biệt giữa `reshape(B, H, T, dh)` trực tiếp và `reshape(B, T, H, dh).transpose(0, 2, 1, 3)`.
2. Ghi giả thuyết vào cell Phác thảo.
3. Sửa cả bước **tách head** lẫn bước **gộp head** trong `multi_head_attention`.
