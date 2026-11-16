def attention_temp(Q, K, V, tau=1.0, mask=None):
    """Q: (..., T, d), K: (..., S, d), V: (..., S, dv), tau > 0, mask: bool broadcast được về (..., T, S).
    weights = softmax(Q K^T / (tau * sqrt(d))) theo trục cuối. Trả về (out (..., T, dv), weights (..., T, S))."""
    ...
