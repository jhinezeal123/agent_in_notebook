Cho hai tập điểm `X` shape `(n, d)` và `Y` shape `(m, d)`. Viết `pairwise_sqdist(X, Y)` trả về ma trận `D` shape `(n, m)` với

$$D_{ij} = \lVert x_i - y_j \rVert^2 .$$

Yêu cầu: **không dùng vòng lặp Python** — chỉ dùng broadcasting và các phép toán mảng của NumPy. Hàm phải chạy đúng khi `n ≠ m` và khi `d = 1`.

Đây là phép toán nằm sau k-NN, k-means, RBF kernel và cả attention, nên bạn sẽ gặp lại nó rất nhiều lần.
