def attention(Q, K, V, mask=None):
    """Q: (..., T, d), K: (..., S, d), V: (..., S, dv), mask: bool broadcast được về (..., T, S).
    Trả về (out (..., T, dv), weights (..., T, S))."""
    ...
