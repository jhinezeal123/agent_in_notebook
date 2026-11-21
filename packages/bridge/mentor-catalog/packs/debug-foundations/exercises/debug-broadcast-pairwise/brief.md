Cell bài làm đã có sẵn hàm `pairwise_sqdist(X, Y)` tính ma trận khoảng cách Euclid bình phương $D_{ij} = \|X_i - Y_j\|_2^2$ với $X \in \mathbb{R}^{N \times D}$, $Y \in \mathbb{R}^{M \times D}$.

**Triệu chứng:** Code chạy không báo lỗi cú pháp, nhưng đầu ra không còn có shape $(N, M)$ và các phần tử trên đường chéo khi $X = Y$ không bằng 0.

**Việc của bạn:**
1. Chạy Phòng công thức để quan sát shape và giá trị bị lệch.
2. Ghi giả thuyết vào cell Phác thảo (triệu chứng → nghi ngờ → cách kiểm).
3. Sửa `pairwise_sqdist(X, Y)` sao cho chạy đúng, trả về shape $(N, M)$, vectorized (không vòng lặp theo từng cặp) và không làm thay đổi đầu vào.
