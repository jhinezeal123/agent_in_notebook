def multi_head_attention(x, Wq, Wk, Wv, Wo, n_heads, causal=False):
    B, T, D = x.shape
    if D % n_heads:
        raise ValueError("D % H != 0")
    dh = D // n_heads
    q = (x @ Wq).reshape(B, T, dh, n_heads).transpose(0, 3, 1, 2)
    k = (x @ Wk).reshape(B, T, dh, n_heads).transpose(0, 3, 1, 2)
    v = (x @ Wv).reshape(B, T, dh, n_heads).transpose(0, 3, 1, 2)
    s = q @ k.swapaxes(-1, -2) / np.sqrt(dh)
    if causal:
        s = np.where(np.tril(np.ones((T, T), dtype=bool)), s, -np.inf)
    s = np.exp(s - s.max(-1, keepdims=True))
    w = s / s.sum(-1, keepdims=True)
    o = (w @ v).transpose(0, 2, 3, 1).reshape(B, T, D)
    return o @ Wo, w
