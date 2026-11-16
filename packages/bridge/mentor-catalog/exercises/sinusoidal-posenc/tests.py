def _pe(user, *args, **kw):
    out = need(user, "positional_encoding")(*args, **kw)
    assert out is not None, "Hàm chưa trả về gì."
    return np.asarray(out, dtype=float)


def test_shape(user, ref):
    """Shape (T, d)"""
    pe = _pe(user, 7, 12)
    assert pe.shape == (7, 12), f"Shape là {pe.shape}, cần (7, 12)."


def test_position_zero(user, ref):
    """Vị trí 0 là [0, 1, 0, 1, …]"""
    pe = _pe(user, 3, 8)
    assert pe.shape == (3, 8), f"Shape là {pe.shape}, cần (3, 8)."
    assert np.allclose(pe[0], [0, 1] * 4), f"Hàng pos = 0 là {np.round(pe[0], 3)}: vị trí đếm từ đâu, và sin/cos nằm ở cột nào?"


def test_interleaved(user, ref):
    """Cột chẵn là sin, cột lẻ là cos, xen kẽ"""
    pe = _pe(user, 20, 8)
    pos = np.arange(20)
    assert pe.shape == (20, 8), f"Shape là {pe.shape}, cần (20, 8)."
    assert np.allclose(pe[:, 0], np.sin(pos)) and np.allclose(pe[:, 1], np.cos(pos)), "Cột 0 và cột 1 là một cặp có tần số 1: một cột sin, một cột cos. Kiểm thứ tự và cách xếp cột."
    assert np.allclose(pe[:, 0::2] ** 2 + pe[:, 1::2] ** 2, 1), "Mỗi cặp cột (2i, 2i+1) phải là (sin, cos) của cùng một góc: tổng bình phương bằng 1."


def test_frequencies(user, ref):
    """Tần số của cặp i là base^(−2i/d)"""
    pe = _pe(user, 50, 16)
    want = ref["positional_encoding"](50, 16)
    assert pe.shape == want.shape, f"Shape là {pe.shape}, cần {want.shape}."
    assert np.allclose(pe[:, 0::2], want[:, 0::2], atol=1e-9), "Các cột sin chưa đúng: số mũ dùng chỉ số cặp hay chỉ số cột?"
    assert np.allclose(pe, want, atol=1e-9), "Các cột cos chưa đúng: cột 2i+1 dùng cùng tần số với cột 2i."


def test_base(user, ref):
    """Tham số base được dùng"""
    pe = _pe(user, 30, 10, base=100.0)
    want = ref["positional_encoding"](30, 10, base=100.0)
    assert pe.shape == want.shape and np.allclose(pe, want, atol=1e-9), "Với base = 100 kết quả chưa đúng."


def test_relative_dot(user, ref):
    """PE[p]·PE[q] chỉ phụ thuộc p − q"""
    pe = _pe(user, 64, 32)
    assert pe.shape == (64, 32), f"Shape là {pe.shape}, cần (64, 32)."
    a, b, c = pe[3] @ pe[10], pe[20] @ pe[27], pe[50] @ pe[57]
    assert np.isclose(a, b) and np.isclose(b, c), f"PE[3]·PE[10] = {a:.4f}, PE[20]·PE[27] = {b:.4f}, PE[50]·PE[57] = {c:.4f}: lẽ ra bằng nhau."
    assert np.isclose(pe[5] @ pe[5], 16.0), "Mỗi hàng phải có chuẩn bình phương d/2."


def test_odd_d(user, ref):
    """d lẻ thì raise ValueError"""
    f = need(user, "positional_encoding")
    try:
        f(4, 7)
    except ValueError:
        return
    except Exception as e:
        raise AssertionError(f"d lẻ cần ValueError, nhưng gặp {type(e).__name__}.")
    raise AssertionError("d lẻ mà hàm không raise ValueError.")
