def _softmax_last(z):
    z = z - z.max(axis=-1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(axis=-1, keepdims=True)


def _split_heads(a, n_heads):
    B, T, D = a.shape
    return a.reshape(B, T, n_heads, D // n_heads).transpose(0, 2, 1, 3)


def multi_head_attention(x, Wq, Wk, Wv, Wo, n_heads, causal=False):
    x = np.asarray(x, dtype=float)
    B, T, D = x.shape
    if D % n_heads:
        raise ValueError("d_model phải chia hết cho n_heads")
    q, k, v = (_split_heads(x @ np.asarray(W, dtype=float), n_heads) for W in (Wq, Wk, Wv))
    scores = q @ k.transpose(0, 1, 3, 2) / np.sqrt(D // n_heads)
    if causal:
        keep = np.tril(np.ones((T, T), dtype=bool))
        scores = np.where(keep, scores, -np.inf)
    weights = _softmax_last(scores)
    merged = (weights @ v).transpose(0, 2, 1, 3).reshape(B, T, D)
    return merged @ np.asarray(Wo, dtype=float), weights
