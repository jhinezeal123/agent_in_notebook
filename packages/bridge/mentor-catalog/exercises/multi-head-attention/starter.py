def multi_head_attention(x, Wq, Wk, Wv, Wo, n_heads, causal=False):
    """x: (B, T, D); Wq, Wk, Wv, Wo: (D, D); n_heads chia hết D (không thì ValueError).
    Head h dùng các cột h*d_h ... (h+1)*d_h - 1 của Q, K, V.
    Trả về (out (B, T, D), weights (B, H, T, T))."""
    ...
