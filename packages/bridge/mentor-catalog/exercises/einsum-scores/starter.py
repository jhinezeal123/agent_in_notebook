def batched_scores(Q, K):
    """Q: (B, H, T, d), K: (B, H, S, d) -> (B, H, T, S)."""
    ...


def bilinear(x, W, y):
    """x: (B, n), W: (n, m), y: (B, m) -> (B,), out[b] = x[b] @ W @ y[b]."""
    ...
