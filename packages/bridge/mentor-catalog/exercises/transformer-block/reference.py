def gelu(x):
    x = np.asarray(x, dtype=float)
    inner = np.sqrt(2.0 / np.pi) * (x + 0.044715 * np.power(x, 3))
    return 0.5 * x * (1.0 + np.tanh(inner))


def _ln(x, g, b, eps):
    centered = x - x.mean(axis=-1, keepdims=True)
    return g * centered / np.sqrt((centered ** 2).mean(axis=-1, keepdims=True) + eps) + b


def _self_attention(u, p, n_heads, causal):
    B, T, D = u.shape
    dh = D // n_heads

    def heads(a):
        return a.reshape(B, T, n_heads, dh).transpose(0, 2, 1, 3)

    q, k, v = heads(u @ p["Wq"]), heads(u @ p["Wk"]), heads(u @ p["Wv"])
    s = np.einsum("bhtd,bhsd->bhts", q, k) / np.sqrt(dh)
    if causal:
        s = np.where(np.tril(np.ones((T, T), dtype=bool)), s, -np.inf)
    s = np.exp(s - s.max(axis=-1, keepdims=True))
    a = s / s.sum(axis=-1, keepdims=True)
    o = np.einsum("bhts,bhsd->bthd", a, v).reshape(B, T, D)
    return o @ p["Wo"]


def transformer_block(x, params, n_heads, causal=False, eps=1e-5):
    x = np.asarray(x, dtype=float)
    p = params
    h = x + _self_attention(_ln(x, p["ln1_g"], p["ln1_b"], eps), p, n_heads, causal)
    u = _ln(h, p["ln2_g"], p["ln2_b"], eps)
    return h + gelu(u @ p["W1"] + p["b1"]) @ p["W2"] + p["b2"]
