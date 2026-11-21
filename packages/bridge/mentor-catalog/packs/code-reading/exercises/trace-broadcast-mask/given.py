def mystery_block_a(X, mask):
    w = mask.astype(float)[:, :, None]
    denom = np.maximum(w.sum(axis=1, keepdims=True), 1.0)
    mu = (X * w).sum(axis=1, keepdims=True) / denom
    R = (X - mu) * w
    out = np.sqrt((R * R).sum(axis=1) / denom[:, 0, :])
    return w, mu, R, out
