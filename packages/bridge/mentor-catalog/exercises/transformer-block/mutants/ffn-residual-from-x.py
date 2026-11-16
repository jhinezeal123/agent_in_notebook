def gelu(x):
    return 0.5 * x * (1 + np.tanh(np.sqrt(2 / np.pi) * (x + 0.044715 * x ** 3)))


def layer_norm(x, g, b, eps):
    mu = x.mean(-1, keepdims=True)
    var = x.var(-1, keepdims=True)
    return g * (x - mu) / np.sqrt(var + eps) + b


def mha(u, Wq, Wk, Wv, Wo, H, causal):
    B, T, D = u.shape
    dh = D // H
    q = (u @ Wq).reshape(B, T, H, dh).transpose(0, 2, 1, 3)
    k = (u @ Wk).reshape(B, T, H, dh).transpose(0, 2, 1, 3)
    v = (u @ Wv).reshape(B, T, H, dh).transpose(0, 2, 1, 3)
    s = q @ k.transpose(0, 1, 3, 2) / np.sqrt(dh)
    if causal:
        s = np.where(np.tril(np.ones((T, T), dtype=bool)), s, -np.inf)
    s = np.exp(s - s.max(-1, keepdims=True))
    w = s / s.sum(-1, keepdims=True)
    return (w @ v).transpose(0, 2, 1, 3).reshape(B, T, D) @ Wo


def ffn(u, p):
    return gelu(u @ p["W1"] + p["b1"]) @ p["W2"] + p["b2"]


def transformer_block(x, params, n_heads, causal=False, eps=1e-5):
    p = params
    attn = lambda u: mha(u, p["Wq"], p["Wk"], p["Wv"], p["Wo"], n_heads, causal)
    h = x + attn(layer_norm(x, p["ln1_g"], p["ln1_b"], eps))
    return x + ffn(layer_norm(h, p["ln2_g"], p["ln2_b"], eps), p)
