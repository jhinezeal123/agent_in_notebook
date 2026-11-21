def test_shapes_general(user, ref):
    """Đoán đúng shape w, mu, R, out cho nhiều bộ (B, T, D) khác nhau"""
    fn = need(user, "trace_shapes")
    for dims in [(2, 5, 3), (1, 1, 7), (4, 9, 2), (3, 2, 8)]:
        got = fn(*dims)
        want = ref["trace_shapes"](*dims)
        assert isinstance(got, dict), "trace_shapes phải trả về dict."
        assert set(got.keys()) == set(want.keys()), f"Thiếu hoặc thừa khóa: cần {sorted(want.keys())}."
        for k in want:
            assert tuple(got[k]) == want[k], f"Shape của '{k}' với {dims} là {got[k]}, chưa khớp."


def test_invariants_match_block(user, ref):
    """Các bất biến dự đoán khớp với kết quả chạy thật của mystery_block_a"""
    t.seed(42)
    X = np.random.randn(3, 6, 4) * 2.5 + 1.0
    mask = np.array([[1, 1, 1, 0, 0, 0], [1, 1, 1, 1, 1, 0], [1, 0, 0, 0, 0, 0]], dtype=bool)
    shift = np.random.randn(3, 1, 4) * 5.0
    got = need(user, "predict_invariants")(X, mask, shift)
    assert isinstance(got, dict), "predict_invariants phải trả về dict."
    _w, _mu, R, out = ref["mystery_block_a"](X, mask)
    _w2, _mu2, _R2, out2 = ref["mystery_block_a"](X + shift, mask)
    t.close(got["sum_R_over_T"], R.sum(axis=1), tol=1e-6, what="sum_R_over_T")
    t.close(got["masked_R_max_abs"], float(np.abs(R[~mask]).max()), tol=1e-6, what="masked_R_max_abs")
    t.close(got["out_shift_diff"], float(np.abs(out2 - out).max()), tol=1e-6, what="out_shift_diff")


def test_no_direct_call(user, ref):
    """Suy luận trực tiếp, không gọi lại mystery_block_a"""
    saved = user.get("mystery_block_a")
    def _blocked(*_a, **_kw):
        raise AssertionError("Hãy suy luận trực tiếp bằng đại số, không gọi mystery_block_a.")
    user["mystery_block_a"] = _blocked
    try:
        t.seed(3)
        X = np.random.randn(2, 4, 3)
        mask = np.array([[1, 1, 0, 0], [1, 1, 1, 0]], dtype=bool)
        shift = np.random.randn(2, 1, 3)
        got = need(user, "predict_invariants")(X, mask, shift)
        want = ref["predict_invariants"](X, mask, shift)
        t.close(got["sum_R_over_T"], want["sum_R_over_T"], what="sum_R_over_T")
        t.close(got["masked_R_max_abs"], want["masked_R_max_abs"], what="masked_R_max_abs")
        t.close(got["out_shift_diff"], want["out_shift_diff"], what="out_shift_diff")
    finally:
        user["mystery_block_a"] = saved


def test_single_token_batch(user, ref):
    """Ca biên batch 1 và chỉ có 1 token hợp lệ"""
    X = np.array([[[3.0, -2.0], [9.0, 9.0]]])
    mask = np.array([[True, False]])
    shift = np.array([[[10.0, -5.0]]])
    got = need(user, "predict_invariants")(X, mask, shift)
    want = ref["predict_invariants"](X, mask, shift)
    t.shape(got["sum_R_over_T"], (1, 2), what="sum_R_over_T")
    t.close(got["sum_R_over_T"], want["sum_R_over_T"])
    t.close(got["out_shift_diff"], want["out_shift_diff"])
