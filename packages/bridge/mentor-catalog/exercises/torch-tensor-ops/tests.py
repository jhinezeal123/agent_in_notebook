def _g(seed):
    return torch.Generator().manual_seed(seed)


def test_pairwise_values(user, ref):
    """pairwise_sq_dists: shape (N, M) và đúng giá trị khi N ≠ M"""
    f = need(user, "pairwise_sq_dists")
    g = _g(0)
    x = torch.randn(5, 3, generator=g)
    y = torch.randn(7, 3, generator=g)
    out = f(x, y)
    got = tuple(getattr(out, "shape", ()))
    assert got == (5, 7), f"Shape là {got}, cần (5, 7): hàng i phải ứng với x[i], cột j ứng với y[j]."
    t.close(out, ref["pairwise_sq_dists"](x, y), tol=1e-4, what="khoảng cách bình phương")


def test_pairwise_self(user, ref):
    """pairwise_sq_dists(x, x): đối xứng, không âm, đường chéo bằng 0"""
    f = need(user, "pairwise_sq_dists")
    x = torch.randn(6, 4, generator=_g(1)) * 10
    out = f(x, x)
    t.shape(out, (6, 6), what="pairwise_sq_dists(x, x)")
    d = t.array(out)
    assert np.all(np.isfinite(d)), "Kết quả có NaN hoặc inf."
    assert np.allclose(np.diag(d), 0, atol=1e-3), "Khoảng cách từ một điểm tới chính nó phải bằng 0."
    assert np.allclose(d, d.T, atol=1e-3), "Ma trận khoảng cách của x với chính nó phải đối xứng."
    assert (d >= -1e-3).all(), "Có khoảng cách bình phương âm."


def test_pick_values(user, ref):
    """pick_logprobs với logits (B, C) và targets int64"""
    f = need(user, "pick_logprobs")
    logits = torch.randn(4, 6, generator=_g(2))
    targets = torch.tensor([0, 5, 2, 2], dtype=torch.int64)
    out = f(logits, targets)
    got = tuple(getattr(out, "shape", ()))
    assert got == (4,), f"Shape là {got}, cần (4,): mỗi mẫu một con số (nhớ bỏ trục thừa)."
    t.close(out, ref["pick_logprobs"](logits, targets), what="log-xác suất của lớp đúng")
    assert (t.array(out) <= 1e-6).all(), "Log-xác suất phải ≤ 0."


def test_pick_3d(user, ref):
    """pick_logprobs với logits (B, T, C): softmax theo trục cuối"""
    f = need(user, "pick_logprobs")
    g = _g(3)
    logits = torch.randn(2, 3, 5, generator=g) * 2
    targets = torch.randint(0, 5, (2, 3), generator=g)
    out = f(logits, targets)
    got = tuple(getattr(out, "shape", ()))
    assert got == (2, 3), f"Shape là {got}, cần (2, 3)."
    t.close(out, ref["pick_logprobs"](logits, targets), what="log-xác suất với logits 3 chiều")


def test_pick_large_logits(user, ref):
    """pick_logprobs hữu hạn khi logits cỡ ±1000"""
    f = need(user, "pick_logprobs")
    logits = torch.randn(3, 4, generator=_g(4)) * 1000
    targets = logits.argmin(dim=-1)
    out = f(logits, targets)
    assert np.all(np.isfinite(t.array(out))), "Ra -inf hoặc NaN với logits lớn: xác suất bị làm tròn về 0 trước khi lấy log."
    t.close(out, ref["pick_logprobs"](logits, targets), tol=1e-4, what="log-xác suất với logits lớn")


def test_scores(user, ref):
    """batched_scores: shape (B, H, T, S) và đúng giá trị"""
    f = need(user, "batched_scores")
    g = _g(5)
    q = torch.randn(2, 3, 4, 8, generator=g)
    k = torch.randn(2, 3, 5, 8, generator=g)
    out = f(q, k)
    got = tuple(getattr(out, "shape", ()))
    assert got == (2, 3, 4, 5), f"Shape là {got}, cần (2, 3, 4, 5): trục T của q đứng trước trục S của k."
    t.close(out, ref["batched_scores"](q, k), what="scores")


def test_scores_one_entry(user, ref):
    """batched_scores: một phần tử khớp phép tính tay"""
    f = need(user, "batched_scores")
    g = _g(6)
    q = torch.randn(1, 2, 3, 16, generator=g)
    k = torch.randn(1, 2, 6, 16, generator=g)
    out = f(q, k)
    t.shape(out, (1, 2, 3, 6), what="batched_scores(q, k)")
    want = float((q[0, 1, 2] * k[0, 1, 4]).sum()) / 4.0
    got = float(out[0, 1, 2, 4])
    assert abs(got - want) < 1e-5 * (1 + abs(want)), f"scores[0, 1, 2, 4] = {got:.5f}, tính tay ra {want:.5f}: kiểm hệ số chia và cặp trục được nhân."
