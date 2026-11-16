def gelu(x):
    """GELU, bản xấp xỉ tanh trong đề. x: mảng bất kỳ -> cùng shape."""
    ...


def transformer_block(x, params, n_heads, causal=False, eps=1e-5):
    """Pre-LN: h = x + MHA(LN1(x)); y = h + FFN(LN2(h)).
    x: (B, T, D); params: dict như bảng trong đề -> (B, T, D).
    Tự viết các hàm phụ (layer_norm, attention, ...) ngay trong cell này."""
    ...
