def trace_shapes(B, T, D):
    """Trả về dict shape của w, mu, R, out cho đầu vào X (B, T, D) và mask (B, T)."""
    raise NotImplementedError


def predict_invariants(X, mask, shift):
    """Dự đoán bất biến đại số của mystery_block_a mà không gọi mystery_block_a."""
    raise NotImplementedError
