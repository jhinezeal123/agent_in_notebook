Viết hai hàm cho **Ridge Regression** với hệ số chệch (bias) $b$ **không bị phạt L2**:
$$\min_{w \in \mathbb{R}^D,\, b \in \mathbb{R}} \frac{1}{N} \sum_{i=1}^N (x_i^\top w + b - y_i)^2 + \lambda \|w\|_2^2.$$

1. `ridge_fit(X, y, lam=1.0)`: trả về `(w, b)` với `w` shape $(D,)$ và `b` là số thực `float`.
   - Gợi ý toán học: lấy đạo hàm theo $b$ suy ra $b = \bar{y} - \bar{x}^\top w$; thay vào bài toán quy tâm ta thu được hệ tuyến tính:
     $$\left(\frac{1}{N} \tilde{X}^\top \tilde{X} + \lambda I_D\right) w = \frac{1}{N} \tilde{X}^\top \tilde{y}.$$
   - Giải hệ tuyến tính trực tiếp bằng `np.linalg.solve` (tránh tính nghịch đảo ma trận tường minh nếu không cần).
2. `ridge_predict(X, w, b)`: trả về vector dự đoán shape $(N,)$: $\hat{y} = X w + b$.

**Shape vào / ra:** `X` shape $(N, D)$, `y` shape $(N,)$, `lam >= 0`. Không sửa `X, y` tại chỗ.
