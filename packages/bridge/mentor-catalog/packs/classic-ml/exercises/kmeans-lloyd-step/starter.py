def assign_clusters(X, centroids):
    """Gán mỗi điểm X (N, D) vào chỉ số tâm gần nhất trong centroids (K, D). Trả về labels (N,)."""
    raise NotImplementedError


def update_centroids(X, labels, old_centroids):
    """Cập nhật tâm cụm (K, D); nếu cụm k rỗng thì giữ nguyên old_centroids[k]."""
    raise NotImplementedError
