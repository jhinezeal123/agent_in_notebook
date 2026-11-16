def cosine_sim(X, Y, eps=1e-8):
    """X: (n, d), Y: (m, d) -> S: (n, m), S[i, j] = x_i·y_j / (max(||x_i||, eps) * max(||y_j||, eps)).
    Không dùng vòng lặp."""
    ...
