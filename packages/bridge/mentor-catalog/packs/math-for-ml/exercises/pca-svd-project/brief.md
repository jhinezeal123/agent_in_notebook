Viết hàm `pca_fit_transform(X, k)` thực hiện Principal Component Analysis (PCA) giảm chiều từ $D$ xuống $k$ bằng thin SVD.

**Công thức:**
1. Quy tâm dữ liệu: $\tilde{X} = X - \mu$, với $\mu = \frac{1}{N} \sum_{i=1}^N X_i \in \mathbb{R}^{1 \times D}$.
2. Phân rã thin SVD: $\tilde{X} = U \Sigma V^\top$ với các giá trị kỳ dị sắp giảm dần $\sigma_1 \ge \sigma_2 \ge \dots \ge \sigma_r \ge 0$.
3. $k$ thành phần chính đầu tiên là $W_k = V_{:k}^\top \in \mathbb{R}^{k \times D}$.
4. Tọa độ chiếu: $Z = \tilde{X} W_k^\top \in \mathbb{R}^{N \times k}$.
5. Tỉ lệ phương sai giải thích: $\text{evr}_j = \frac{\sigma_j^2}{\sum_{m=1}^r \sigma_m^2}$ cho $j = 1, \dots, k$ (nếu tổng phương sai bằng 0 thì trả về mảng $k$ số 0).

**Shape vào / ra:**
- Vào: `X` shape $(N, D)$, `k` nguyên với $1 \le k \le \min(N, D)$.
- Ra: tuple `(Z, components, evr)` với `Z` shape $(N, k)$, `components` shape $(k, D)$, `evr` shape $(k,)$.
- Không làm thay đổi `X` tại chỗ.
