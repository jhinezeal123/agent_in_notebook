**Biến thể của bài khoảng cách từng cặp.** Thay vì khoảng cách, tính **cosine similarity** giữa mọi cặp hàng: `X` shape `(n, d)`, `Y` shape `(m, d)`, kết quả `S` shape `(n, m)` với

$$S_{ij} = \frac{x_i^\top y_j}{\max(\lVert x_i \rVert, \epsilon)\cdot \max(\lVert y_j \rVert, \epsilon)}, \qquad \epsilon = 10^{-8}.$$

Viết `cosine_sim(X, Y, eps=1e-8)`:

- $\lVert\cdot\rVert$ là chuẩn L2 của **từng hàng**. Mỗi chuẩn được **kẹp dưới** bằng ε riêng (lấy `max`, không cộng thêm ε), nên một hàng toàn số 0 cho cả hàng/cột tương ứng của `S` bằng 0, không ra `nan`.
- **Không dùng vòng lặp Python**; chạy đúng khi `n ≠ m` và khi `d = 1`.

Đây là phép toán nằm sau retrieval bằng embedding, contrastive loss (CLIP, SimCLR) và k-NN trên vector đã chuẩn hoá.
