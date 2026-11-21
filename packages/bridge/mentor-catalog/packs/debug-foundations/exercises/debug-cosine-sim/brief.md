Cell bài làm có sẵn hàm `cosine_sim(X, Y, eps=1e-8)` tính ma trận tương đồng cosine $S_{ij} = \frac{X_i \cdot Y_j}{\max(\|X_i\|_2, \varepsilon)\,\max(\|Y_j\|_2, \varepsilon)}$ cho $X \in \mathbb{R}^{N \times D}$, $Y \in \mathbb{R}^{M \times D}$.

**Triệu chứng:** Khi $Y$ có các vector biên độ lớn (ví dụ $\|Y_j\|_2 = 10$), kết quả vượt hẳn khỏi khoảng $[-1, 1]$ và $S(X, X)$ không có đường chéo bằng $1$.

**Việc của bạn:**
1. Chạy Phòng công thức để thấy phân bố giá trị bất thường.
2. Đặt giả thuyết trước khi sửa.
3. Sửa `cosine_sim(X, Y, eps=1e-8)` đảm bảo ổn định với vector 0, chuẩn hóa đúng cả hai phía và trả về shape $(N, M)$.
