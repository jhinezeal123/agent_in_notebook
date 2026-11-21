def trace_shapes(B, T, D, d):
    """Trả về dict shape của Q, S, A, Y với X (B, T, D) và Wq, Wk, Wv (D, d)."""
    raise NotImplementedError


def predict_causal_weights(T, d):
    """Dự đoán ma trận trọng số A khi điểm attention đồng nhất, không gọi mystery_block_c."""
    raise NotImplementedError
