def test_shapes_general(user, ref):
    """Đoán đúng shape Q, S, A, Y cho nhiều bộ (B, T, D, d) khác nhau"""
    fn = need(user, "trace_shapes")
    for dims in [(2, 5, 8, 4), (1, 1, 3, 6), (3, 7, 4, 2)]:
        got = fn(*dims)
        want = ref["trace_shapes"](*dims)
        assert isinstance(got, dict) and set(got.keys()) == set(want.keys()), "Dict shape thiếu hoặc thừa khóa."
        for k in want:
            assert tuple(got[k]) == want[k], f"Shape '{k}' với {dims} là {got[k]}, chưa khớp."


def test_uniform_weights_match_block(user, ref):
    """Ma trận trọng số dự đoán khớp với mystery_block_c khi Wq = 0"""
    t.seed(5)
    B, T, D, d = 2, 6, 4, 9
    X = np.random.randn(B, T, D)
    Wq = np.zeros((D, d))
    Wk = np.random.randn(D, d)
    Wv = np.random.randn(D, d)
    _Q, _S, A, _Y = ref["mystery_block_c"](X, Wq, Wk, Wv)
    got = need(user, "predict_causal_weights")(T, d)
    t.close(got["A_uniform"], A[0], tol=1e-6, what="A_uniform")
    upper = float(np.triu(A[0], k=1).sum())
    t.close(got["upper_triangle_sum"], upper, tol=1e-6, what="upper_triangle_sum")
    t.close(got["scale_factor"], 1.0 / np.sqrt(d), tol=1e-6, what="scale_factor")


def test_no_direct_call(user, ref):
    """Suy luận trực tiếp, không gọi lại mystery_block_c"""
    saved = user.get("mystery_block_c")
    def _blocked(*_a, **_kw):
        raise AssertionError("Không gọi mystery_block_c; hãy tự suy luận.")
    user["mystery_block_c"] = _blocked
    try:
        got = need(user, "predict_causal_weights")(5, 16)
        want = ref["predict_causal_weights"](5, 16)
        t.close(got["A_uniform"], want["A_uniform"], what="A_uniform")
        t.close(got["scale_factor"], want["scale_factor"], what="scale_factor")
    finally:
        user["mystery_block_c"] = saved


def test_t1_edge_case(user, ref):
    """Ca biên chuỗi độ dài T = 1"""
    got = need(user, "predict_causal_weights")(1, 4)
    t.shape(got["A_uniform"], (1, 1), what="A_uniform")
    t.close(got["A_uniform"], np.array([[1.0]]))
    t.close(got["upper_triangle_sum"], 0.0)
