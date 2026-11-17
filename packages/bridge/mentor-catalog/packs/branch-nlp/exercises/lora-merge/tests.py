IN, OUT, R, ALPHA = 6, 4, 2, 6.0


def _g(seed):
    return torch.Generator().manual_seed(seed)


def _lora(ref, in_f=IN, out_f=OUT, r=R, alpha=ALPHA, bias=True, seed=0):
    """Một LoRALinear chuẩn đã "học" (B khác 0), để gộp."""
    t.seed(seed)
    m = ref["LoRALinear"](nn.Linear(in_f, out_f, bias=bias), r, alpha)
    with torch.no_grad():
        m.B.copy_(torch.randn(m.B.shape, generator=_g(seed + 1)))
    return m


def _merge(user, lora):
    return need(user, "merge")(lora)


def test_returns_linear(user, ref):
    """Trả về một nn.Linear thường (không phải LoRALinear) với in/out_features và shape weight (out, in) đúng; có bias thì có bias, không thì None"""
    for bias in [True, False]:
        lora = _lora(ref, bias=bias, seed=1)
        merged = _merge(user, lora)
        assert type(merged) is nn.Linear, f"merge trả về {type(merged).__name__}, cần một nn.Linear thường (không còn nhánh A, B)."
        assert (merged.in_features, merged.out_features) == (IN, OUT), f"Linear trả về có in/out = ({merged.in_features}, {merged.out_features}), cần ({IN}, {OUT})."
        t.shape(merged.weight, (OUT, IN), what="weight của bản gộp (out, in)")
        if bias:
            assert merged.bias is not None and tuple(merged.bias.shape) == (OUT,), "base có bias thì bản gộp phải có bias shape (out,)."
        else:
            assert merged.bias is None, "base không có bias thì bản gộp cũng không có bias (bias phải là None)."


def test_same_output(user, ref):
    """Bản gộp cho đúng đầu ra của LoRALinear với x 1, 2, 3 chiều, có và không bias, lớp vuông và không vuông"""
    for in_f, out_f, r, alpha in [(6, 4, 2, 6.0), (5, 5, 3, 3.0)]:
        for bias in [True, False]:
            lora = _lora(ref, in_f, out_f, r, alpha, bias, seed=2)
            merged = _merge(user, lora)
            g = _g(3)
            for shape in [(in_f,), (5, in_f), (2, 3, in_f)]:
                x = torch.randn(shape, generator=g)
                with torch.no_grad():
                    want = lora(x)
                    got = merged(x)
                t.close(got, want, tol=1e-4, what=f"đầu ra của bản gộp ({in_f} → {out_f}, r = {r}, bias = {bias}) với x shape {shape}")


def test_weight_formula(user, ref):
    """Trọng số gộp bằng W + (α/r)·B·A (B nhân A, đúng hướng, đúng hệ số), bias giữ nguyên; B = 0 thì trọng số không đổi"""
    for in_f, out_f, r, alpha in [(6, 4, 2, 6.0), (5, 5, 3, 3.0), (3, 7, 2, 8.0)]:
        lora = _lora(ref, in_f, out_f, r, alpha, seed=4)
        merged = _merge(user, lora)
        want = lora.base.weight.detach() + lora.scale * (lora.B.detach() @ lora.A.detach())
        t.close(merged.weight, want, tol=1e-5, what=f"trọng số gộp với in = {in_f}, out = {out_f}, r = {r}, α = {alpha} (độ lệch là B nhân A, nhân α/r)")
        t.close(merged.bias, lora.base.bias.detach(), tol=1e-7, what="bias của bản gộp (phải giữ y nguyên bias của base)")
    lora = _lora(ref, seed=5)
    with torch.no_grad():
        lora.B.zero_()
    t.close(_merge(user, lora).weight, lora.base.weight.detach(), tol=1e-7, what="trọng số gộp khi B = 0 (adapter chưa học gì)")


def test_lora_untouched(user, ref):
    """merge không sửa LoRALinear gốc: base.weight, base.bias, A, B y nguyên, vẫn đóng băng như cũ, và lora cho cùng đầu ra như trước"""
    lora = _lora(ref, seed=6)
    x = torch.randn(4, IN, generator=_g(7))
    before_out = lora(x).detach().clone()
    before = {k: v.detach().clone() for k, v in lora.state_dict().items()}
    flags = {n: p.requires_grad for n, p in lora.named_parameters()}
    _merge(user, lora)
    for k, v in lora.state_dict().items():
        assert torch.equal(v.detach(), before[k]), f"Sau khi gộp, {k} của LoRALinear gốc đã bị đổi: merge phải trả một lớp mới, không sửa lớp cũ."
    assert {n: p.requires_grad for n, p in lora.named_parameters()} == flags, "merge đã đổi requires_grad của các tham số trong LoRALinear gốc."
    t.close(lora(x), before_out, tol=1e-7, what="đầu ra của LoRALinear gốc sau khi gộp")


def test_independent_copy(user, ref):
    """Bản gộp là một lớp độc lập: sửa weight hoặc bias của nó không làm đổi lora.base, và không dùng chung bộ nhớ"""
    lora = _lora(ref, seed=8)
    w0, b0 = lora.base.weight.detach().clone(), lora.base.bias.detach().clone()
    merged = _merge(user, lora)
    assert merged is not lora.base, "merge trả về chính lora.base: cần một Linear mới."
    assert merged.weight.data_ptr() != lora.base.weight.data_ptr(), "weight của bản gộp dùng chung bộ nhớ với lora.base.weight."
    with torch.no_grad():
        merged.weight.add_(1.0)
        merged.bias.add_(1.0)
    assert torch.equal(lora.base.weight.detach(), w0), "Sửa weight của bản gộp làm đổi lora.base.weight: hai lớp đang dùng chung dữ liệu."
    assert torch.equal(lora.base.bias.detach(), b0), "Sửa bias của bản gộp làm đổi lora.base.bias: bias đang được dùng chung thay vì sao chép."


def test_inference_ready(user, ref):
    """Bản gộp dùng để suy luận: mọi tham số đóng băng, là tensor lá không dính đồ thị autograd, đầu ra không cần gradient, đúng số tham số của một Linear"""
    for bias in [True, False]:
        lora = _lora(ref, bias=bias, seed=9)
        merged = _merge(user, lora)
        names = sorted(n for n, _ in merged.named_parameters())
        assert names == (["bias", "weight"] if bias else ["weight"]), f"Tham số của bản gộp là {names}: chỉ được có tham số của một nn.Linear thường."
        for n, p in merged.named_parameters():
            assert not p.requires_grad, f"{n} của bản gộp vẫn có requires_grad = True: bản gộp để suy luận nên phải đóng băng."
            assert p.grad_fn is None and p.is_leaf, f"{n} của bản gộp còn dính đồ thị tính toán (grad_fn = {p.grad_fn}): nó phải là một tham số lá bình thường."
        count = sum(p.numel() for p in merged.parameters())
        assert count == IN * OUT + (OUT if bias else 0), f"Bản gộp có {count} tham số, cần đúng bằng của một nn.Linear({IN}, {OUT})."
        out = merged(torch.randn(3, IN, generator=_g(10)))
        assert not out.requires_grad, "Đầu ra của bản gộp cần gradient dù x không cần: có thứ gì từ A, B còn nằm trong đồ thị?"
