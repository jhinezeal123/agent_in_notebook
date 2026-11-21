def _setup(B=2, T=5, D=16, seed=0, scale=1.0):
    rng = np.random.default_rng(seed)
    x = rng.normal(size=(B, T, D)) * scale
    Ws = [rng.normal(size=(D, D)) / np.sqrt(D) for _ in range(4)]
    return x, Ws


def _call(user, x, Ws, H, causal=False):
    res = need(user, "multi_head_attention")(x, *Ws, H, causal=causal)
    assert isinstance(res, tuple) and len(res) == 2, "Hàm phải trả về một tuple (out, weights)."
    return np.asarray(res[0], float), np.asarray(res[1], float)


def test_shapes(user, ref):
    """out (B, T, D), weights (B, H, T, T), mỗi hàng cộng thành 1"""
    x, Ws = _setup(B=2, T=5, D=12)
    out, w = _call(user, x, Ws, 3)
    assert out.shape == (2, 5, 12), f"out có shape {out.shape}, cần (2, 5, 12)."
    assert w.shape == (2, 3, 5, 5), f"weights có shape {w.shape}, cần (2, 3, 5, 5) = (B, H, T, T)."
    assert np.allclose(w.sum(-1), 1), "Mỗi hàng weights phải cộng thành 1: softmax theo trục nào?"


def test_values(user, ref):
    """Đúng giá trị weights và out (4 head)"""
    x, Ws = _setup(seed=1, D=32)
    out, w = _call(user, x, Ws, 4)
    want_out, want_w = ref["multi_head_attention"](x, *Ws, 4)
    assert w.shape == want_w.shape, f"weights có shape {w.shape}, cần {want_w.shape}."
    assert np.allclose(w, want_w, atol=1e-8), "weights chưa đúng: mỗi head thấy phần nào của Q, K? Mỗi head làm attention trong không gian bao nhiêu chiều?"
    assert np.allclose(out, want_out, atol=1e-8), "weights đúng nhưng out chưa đúng: kiểm phần ghép head và phép chiếu Wo."


def test_head_owns_its_columns(user, ref):
    """Head h chỉ phụ thuộc dải cột h·d_h … (h+1)·d_h − 1 của Wq"""
    x, Ws = _setup(seed=2, D=16)
    _, w0 = _call(user, x, Ws, 4)
    Wq2 = Ws[0].copy()
    Wq2[:, 4:8] += np.random.default_rng(9).normal(size=(16, 4))
    _, w1 = _call(user, x, [Wq2] + Ws[1:], 4)
    assert w0.shape == (2, 4, 5, 5), f"weights có shape {w0.shape}, cần (2, 4, 5, 5)."
    changed = [h for h in range(4) if not np.allclose(w0[:, h], w1[:, h])]
    assert changed == [1], f"Đổi các cột 4…7 của Wq (dải của head 1) thì chỉ head 1 được đổi, nhưng các head đổi là {changed}: cách tách head đang trộn token với feature."


def test_merge_order(user, ref):
    """Ghép head đúng thứ tự (thử với Wo = I)"""
    x, Ws = _setup(seed=3, D=12)
    I = np.eye(12)
    out, w = _call(user, x, Ws[:3] + [I], 3)
    assert out.shape == (2, 5, 12) and w.shape == (2, 3, 5, 5), f"Shape out {out.shape}, weights {w.shape}."
    V = x @ Ws[2]
    for h in range(3):
        head_out = w[:, h] @ V[..., 4 * h:4 * h + 4]
        assert np.allclose(out[..., 4 * h:4 * h + 4], head_out, atol=1e-8), f"Với Wo = I, các cột {4 * h}…{4 * h + 3} của out phải là weights[:, {h}] @ V_{h} cho từng token: tách V và ghép head lại theo đúng thứ tự trục chưa?"


def test_single_head(user, ref):
    """Một head = scaled dot-product attention thường"""
    x, Ws = _setup(seed=4, D=8)
    out, w = _call(user, x, Ws, 1)
    q, k = x @ Ws[0], x @ Ws[1]
    s = q @ k.transpose(0, 2, 1) / np.sqrt(8)
    s = np.exp(s - s.max(-1, keepdims=True))
    s = s / s.sum(-1, keepdims=True)
    assert w.shape == (2, 1, 5, 5), f"weights có shape {w.shape}, cần (2, 1, 5, 5)."
    assert np.allclose(w[:, 0], s, atol=1e-8), "Với 1 head, weights phải là softmax(QKᵀ/√D)."


def test_causal(user, ref):
    """causal: không nhìn tương lai; đổi token cuối không ảnh hưởng token trước"""
    x, Ws = _setup(seed=5, T=6, D=16)
    out, w = _call(user, x, Ws, 4, causal=True)
    future = ~np.tril(np.ones((6, 6), dtype=bool))
    assert np.isfinite(w).all() and np.isfinite(out).all(), "Có nan/inf với causal: hàng đầu tiên còn được nhìn vị trí nào?"
    assert np.allclose(w[:, :, future], 0, atol=1e-12), "Vẫn có trọng số khác 0 tới token tương lai."
    assert np.allclose(w.sum(-1), 1), "Sau khi che, mỗi hàng phải cộng thành 1."
    x2 = x.copy()
    x2[:, -1] += 5.0
    out2, _ = _call(user, x2, Ws, 4, causal=True)
    assert np.allclose(out[:, :-1], out2[:, :-1], atol=1e-10), "Đổi token cuối làm thay đổi output của các token trước nó."
    assert np.allclose(out, ref["multi_head_attention"](x, *Ws, 4, causal=True)[0], atol=1e-8), "out với causal chưa đúng."


def test_bad_heads_and_stability(user, ref):
    """D không chia hết cho H thì ValueError; điểm lớn không ra nan"""
    x, Ws = _setup(D=12)
    try:
        _call(user, x, Ws, 5)
    except ValueError:
        pass
    except AssertionError:
        raise
    except Exception as e:
        raise AssertionError(f"D = 12, H = 5 cần ValueError, nhưng gặp {type(e).__name__}.")
    else:
        raise AssertionError("D = 12, H = 5 không chia hết mà hàm không raise ValueError.")
    x, Ws = _setup(seed=6, D=12, scale=80.0)
    out, w = _call(user, x, Ws, 3)
    assert np.isfinite(out).all() and np.isfinite(w).all(), "Có nan/inf khi điểm lớn: softmax cần ổn định số."
