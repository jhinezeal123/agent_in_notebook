def test_shapes(user, ref):
    """Đoán đúng shape của m, lse, P, H cho nhiều bộ (B, K)"""
    fn = need(user, "trace_shapes")
    for dims in [(1, 2), (4, 10), (7, 3)]:
        got = fn(*dims)
        want = ref["trace_shapes"](*dims)
        assert isinstance(got, dict) and set(got.keys()) == set(want.keys()), "Thiếu hoặc thừa khóa trong dict shape."
        for k in want:
            assert tuple(got[k]) == want[k], f"Shape '{k}' với {dims} là {got[k]}, chưa khớp."


def test_lse_shift_and_entropy(user, ref):
    """Dự đoán đúng độ dịch lse, tổng hàng P và entropy khi Z hằng số"""
    t.seed(11)
    B, K, tau, shift = 3, 5, 2.5, -7.5
    Z = np.random.randn(B, K) * 3.0
    got = need(user, "predict_behavior")(B, K, tau, shift)
    _m1, lse1, P1, _H1 = ref["mystery_block_b"](Z, tau)
    _m2, lse2, _P2, _H2 = ref["mystery_block_b"](Z + shift, tau)
    _mc, _lc, _Pc, Hc = ref["mystery_block_b"](np.full((B, K), 4.2), tau)
    t.close(got["lse_shift_delta"], float((lse2 - lse1).mean()), tol=1e-6, what="lse_shift_delta")
    t.close(got["P_row_sums"], P1.sum(axis=-1), tol=1e-6, what="P_row_sums")
    t.close(got["H_constant_Z"], Hc, tol=1e-6, what="H_constant_Z")


def test_no_direct_call(user, ref):
    """Suy luận trực tiếp, không gọi lại mystery_block_b"""
    saved = user.get("mystery_block_b")
    def _blocked(*_a, **_kw):
        raise AssertionError("Không gọi mystery_block_b; hãy suy luận từ công thức.")
    user["mystery_block_b"] = _blocked
    try:
        got = need(user, "predict_behavior")(4, 8, 0.5, 3.0)
        want = ref["predict_behavior"](4, 8, 0.5, 3.0)
        t.close(got["lse_shift_delta"], want["lse_shift_delta"])
        t.close(got["P_row_sums"], want["P_row_sums"])
        t.close(got["H_constant_Z"], want["H_constant_Z"])
    finally:
        user["mystery_block_b"] = saved


def test_various_tau_and_K(user, ref):
    """Đúng với nhiều giá trị tau khác nhau (tau < 1 và tau > 1)"""
    fn = need(user, "predict_behavior")
    for B, K, tau, shift in [(2, 2, 0.25, 1.5), (5, 16, 4.0, 12.0)]:
        got = fn(B, K, tau, shift)
        want = ref["predict_behavior"](B, K, tau, shift)
        t.close(got["lse_shift_delta"], want["lse_shift_delta"], what="lse_shift_delta")
        t.close(got["H_constant_Z"], want["H_constant_Z"], what="H_constant_Z")
