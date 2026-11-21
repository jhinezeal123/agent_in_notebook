Cài đặt tiêu chí chia nhánh của cây quyết định phân loại (CART):

1. `gini_impurity(y)`: với mảng nhãn nguyên 1D `y` độ dài $N$, tính độ bất thuần Gini:
   $$G(y) = 1 - \sum_c p_c^2, \qquad p_c = \frac{\text{số phần tử có nhãn } c}{N}.$$
   Nếu `y` rỗng ($N = 0$), trả về `0.0`.

2. `best_split(X, y)`: tìm cặp `(feature, threshold, gain)` tối đa hóa **độ giảm Gini có trọng số**:
   $$\Delta G = G(y) - \left(\frac{N_L}{N} G(y_L) + \frac{N_R}{N} G(y_R)\right),$$
   trong đó nhánh trái là $X_{i, j} \le \tau$ và nhánh phải là $X_{i, j} > \tau$.
   - Với mỗi đặc trưng $j \in \{0, \dots, D-1\}$, xét mọi ngưỡng $\tau$ là trung điểm của hai giá trị phân biệt kề nhau sau khi sắp xếp cột $X_{:, j}$.
   - Nếu không có cách chia hợp lệ nào cho $\Delta G > 0$ (ví dụ nút đã thuần nhất hoặc mọi đặc trưng hằng số), trả về `(None, None, 0.0)`.
   - Nếu hòa điểm `gain` trong sai số nhỏ, ưu tiên chỉ số `feature` nhỏ hơn.
