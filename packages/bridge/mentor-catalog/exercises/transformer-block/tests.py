def _params(D=16, F=32, seed=0):
    rng = np.random.default_rng(seed)
    p = {
        "ln1_g": 1 + 0.3 * rng.normal(size=D), "ln1_b": 0.2 * rng.normal(size=D),
        "ln2_g": 1 + 0.3 * rng.normal(size=D), "ln2_b": 0.2 * rng.normal(size=D),
        "W1": rng.normal(size=(D, F)) / np.sqrt(D), "b1": 0.1 * rng.normal(size=F),
        "W2": rng.normal(size=(F, D)) / np.sqrt(F), "b2": 0.1 * rng.normal(size=D),
    }
    for k in ["Wq", "Wk", "Wv", "Wo"]:
        p[k] = rng.normal(size=(D, D)) / np.sqrt(D)
    return p


def _x(B=2, T=5, D=16, seed=1):
    rng = np.random.default_rng(seed)
    return rng.normal(loc=0.5, scale=2.0, size=(B, T, D))


def _block(user, x, p, H, **kw):
    out = need(user, "transformer_block")(x, {k: v.copy() for k, v in p.items()}, H, **kw)
    assert out is not None, "transformer_block chưa trả về gì."
    out = np.asarray(out, dtype=float)
    assert out.shape == x.shape, f"Output có shape {out.shape}, cần {x.shape} như đầu vào."
    return out


def test_gelu(user, ref):
    """gelu: đúng bản xấp xỉ tanh, giữ shape"""
    g = need(user, "gelu")
    z = np.linspace(-6, 6, 49).reshape(7, 7)
    out = g(z)
    assert out is not None, "gelu chưa trả về gì."
    out = np.asarray(out, dtype=float)
    assert out.shape == z.shape, f"gelu đổi shape: {out.shape}, cần {z.shape}."
    assert np.isclose(out[3, 3], 0.0), "gelu(0) phải bằng 0."
    assert np.allclose(out, ref["gelu"](z), atol=1e-10), "gelu chưa khớp công thức xấp xỉ tanh trong đề (kiểm hằng số và lũy thừa)."


def test_shape_and_values(user, ref):
    """Block đúng giá trị (không causal)"""
    p = _params()
    x = _x()
    out = _block(user, x, p, 4)
    assert np.allclose(out, ref["transformer_block"](x, p, 4), atol=1e-8), "Giá trị chưa đúng: đối chiếu từng bước với công thức (LN đặt ở đâu, residual cộng cái gì, LN nào dùng gamma/beta nào)."


def test_identity_when_sublayers_off(user, ref):
    """Tắt cả hai sublayer thì block là hàm đồng nhất"""
    p = _params(seed=2)
    p["Wo"] = np.zeros_like(p["Wo"])
    p["W2"] = np.zeros_like(p["W2"])
    p["b2"] = np.zeros_like(p["b2"])
    x = _x(seed=3)
    out = _block(user, x, p, 2)
    assert np.allclose(out, x, atol=1e-10), "Khi MHA và FFN đều trả về 0, output phải đúng bằng x: residual nối cái gì với cái gì, và có gì nằm trên đường đi thẳng?"


def test_tokens_independent_without_attention(user, ref):
    """Tắt attention thì các token được xử lý độc lập"""
    p = _params(seed=4)
    p["Wo"] = np.zeros_like(p["Wo"])
    x = _x(seed=5)
    out = _block(user, x, p, 4)
    x2 = x.copy()
    x2[:, 0] = x2[:, 0] * 3.0 + 1.0
    out2 = _block(user, x2, p, 4)
    assert np.allclose(out[:, 1:], out2[:, 1:], atol=1e-10), "Không có attention mà đổi token 0 lại làm đổi token khác: LayerNorm đang lấy thống kê theo trục nào?"
    assert np.allclose(out, ref["transformer_block"](x, p, 4), atol=1e-8), "Tắt attention (Wo = 0) mà giá trị vẫn chưa đúng: phần còn lại là residual, LN₂ và FFN."


def test_causal(user, ref):
    """causal: đổi token cuối không ảnh hưởng các token trước"""
    p = _params(seed=6)
    x = _x(T=6, seed=7)
    out = _block(user, x, p, 4, causal=True)
    assert np.isfinite(out).all(), "Có nan/inf với causal."
    x2 = x.copy()
    x2[:, -1] += 4.0
    out2 = _block(user, x2, p, 4, causal=True)
    assert np.allclose(out[:, :-1], out2[:, :-1], atol=1e-10), "Đổi token cuối làm thay đổi output của token trước nó."
    assert np.allclose(out, ref["transformer_block"](x, p, 4, causal=True), atol=1e-8), "Giá trị với causal chưa đúng."


def test_eps_and_heads(user, ref):
    """Dùng eps truyền vào; chạy với số head khác và F khác D"""
    p = _params(D=12, F=20, seed=8)
    x = _x(B=1, T=4, D=12, seed=9) * 0.01
    out = _block(user, x, p, 3, eps=1e-2)
    if np.allclose(out, ref["transformer_block"](x, p, 3), atol=1e-8):
        raise AssertionError("Kết quả với eps = 1e-2 giống hệt eps mặc định: eps truyền vào chưa tới LayerNorm.")
    assert np.allclose(out, ref["transformer_block"](x, p, 3, eps=1e-2), atol=1e-8), "Sai với D = 12, H = 3, F = 20, eps = 1e-2."
