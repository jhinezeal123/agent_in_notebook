Cài đặt hai bước cốt lõi của thuật toán **k-means (Lloyd)** bằng NumPy (vectorized):

1. `assign_clusters(X, centroids)`: gán mỗi điểm $X_i$ vào tâm cụm gần nhất theo khoảng cách Euclid bình phương $\|X_i - c_k\|_2^2$.
   - Vào: `X` shape $(N, D)$, `centroids` shape $(K, D)$.
   - Ra: mảng nguyên `labels` shape $(N,)$ nhận giá trị trong $\{0, \dots, K-1\}$ (nếu khoảng cách bằng nhau thì chọn chỉ số nhỏ hơn — hành vi mặc định của `argmin`).

2. `update_centroids(X, labels, old_centroids)`: cập nhật từng tâm cụm $k$ bằng trung bình các điểm có `labels == k`.
   - **Ca biên cụm rỗng:** Nếu không có điểm nào thuộc cụm $k$, **giữ nguyên** `old_centroids[k]` (không sinh `NaN`).
   - Ra: mảng float shape $(K, D)$, không sửa `old_centroids` tại chỗ.
