def _g(seed):
    return torch.Generator().manual_seed(seed)


def _randn(shape, seed, scale=2.0):
    return torch.randn(shape, generator=_g(seed)) * scale


def _z(b, v):
    # logits xác định (không random): khoảng cách giữa hai logit lớn nhất luôn đủ rộng
    return torch.sin(torch.arange(b * v, dtype=torch.float32).view(b, v) * 1.3 + 0.7) * 3


def test_shapes(user, ref):
    """Giữ nguyên shape của logits (hai và ba chiều), mỗi hàng xác suất cộng thành 1, entropy bỏ trục cuối"""
    f, h = need(user, "temperature_probs"), need(user, "entropy")
    for shape in [(4, 7), (2, 3, 7)]:
        p = f(_randn(shape, 1), 1.5)
        t.shape(p, shape, what=f"xác suất với logits shape {shape}")
        t.close(p.sum(dim=-1), torch.ones(shape[:-1]), tol=1e-5, what="tổng xác suất mỗi hàng (softmax theo trục cuối)")
        t.shape(h(p), shape[:-1], what=f"entropy với xác suất shape {shape}")


def test_values(user, ref):
    """Với temperature dương: đúng softmax(logits / temperature), và temperature = 1 là softmax thường"""
    f = need(user, "temperature_probs")
    z = _randn((5, 9), 2)
    for temp in [0.3, 1.0, 2.5, 10.0]:
        t.close(f(z, temp), ref["temperature_probs"](z, temp), tol=1e-6, what=f"xác suất ở temperature = {temp}")
    t.close(f(z, 1.0), F.softmax(z, dim=-1), tol=1e-6, what="xác suất ở temperature = 1")


def test_sharper_flatter(user, ref):
    """Temperature nhỏ làm phân phối nhọn hơn (entropy giảm), lớn làm phẳng hơn (entropy tăng), thứ tự xếp hạng token không đổi"""
    f, h = need(user, "temperature_probs"), need(user, "entropy")
    z = _randn((5, 9), 3)
    temps = [0.2, 0.5, 1.0, 2.0, 5.0]
    ents = [h(f(z, temp)) for temp in temps]
    for lo, hi, ta, tb in zip(ents, ents[1:], temps, temps[1:]):
        assert bool((hi > lo).all()), f"Entropy phải tăng khi temperature tăng, nhưng từ temperature {ta} lên {tb} có hàng không tăng."
    for temp in temps:
        assert torch.equal(f(z, temp).argmax(dim=-1), z.argmax(dim=-1)), f"Token có xác suất lớn nhất ở temperature = {temp} khác token có logit lớn nhất: chia cho số dương không đổi thứ tự."


def test_zero_temperature(user, ref):
    """temperature = 0 là giới hạn T → 0: one-hot ở logit lớn nhất, không nan, entropy 0; temperature rất nhỏ cũng hữu hạn và gần one-hot"""
    f, h = need(user, "temperature_probs"), need(user, "entropy")
    z = _z(4, 6)
    want = F.one_hot(z.argmax(dim=-1), 6).float()
    p = f(z, 0.0)
    assert torch.isfinite(p).all(), "temperature = 0 ra nan hoặc inf: phép chia cho 0 làm hỏng softmax. Giới hạn của softmax(z / T) khi T → 0 là gì?"
    t.close(p, want, tol=1e-6, what="xác suất ở temperature = 0 (one-hot ở logit lớn nhất)")
    e = h(p)
    assert torch.isfinite(e).all() and float(e.abs().max()) < 1e-6, "Entropy của phân phối one-hot phải bằng 0."
    for temp in [1e-3, 1e-6]:
        q = f(z, temp)
        assert torch.isfinite(q).all(), f"temperature = {temp} ra nan hoặc inf: logits chia cho số rất nhỏ rất lớn, softmax phải chịu được."
        t.close(q, want, tol=1e-4, what=f"xác suất ở temperature = {temp}")


def test_high_temperature(user, ref):
    """Temperature rất lớn (1e5) làm phân phối gần đều: entropy tiến tới ln V (ln của số token còn lại nếu có token bị che)"""
    f, h = need(user, "temperature_probs"), need(user, "entropy")
    z = _z(3, 8)
    t.close(h(f(z, 1e5)), torch.full((3,), float(np.log(8))), tol=1e-4, what="entropy ở temperature = 1e5 với V = 8 (phân phối gần đều)")
    masked = z.clone()
    masked[:, 5:] = float("-inf")
    t.close(h(f(masked, 1e5)), torch.full((3,), float(np.log(5))), tol=1e-4, what="entropy ở temperature = 1e5 khi 3 trong 8 token bị che bằng -inf (còn 5 token)")


def test_masked_logits(user, ref):
    """Logit bằng -inf (token bị che): xác suất đúng 0 ở đó, không nan, entropy chỉ tính trên các token còn lại"""
    f, h = need(user, "temperature_probs"), need(user, "entropy")
    z = _randn((3, 8), 4)
    z[:, 3:6] = float("-inf")
    for temp in [0.7, 2.0]:
        p = f(z, temp)
        assert torch.isfinite(p).all(), f"Có nan hoặc inf ở temperature = {temp} khi một số logit là -inf."
        assert bool((p[:, 3:6] == 0).all()), "Token bị che bằng -inf phải có xác suất đúng 0."
        t.close(p, ref["temperature_probs"](z, temp), tol=1e-6, what=f"xác suất ở temperature = {temp} với token bị che")
        e = h(p)
        assert torch.isfinite(e).all(), "Entropy ra nan khi có xác suất bằng đúng 0: theo quy ước 0·ln 0 = 0 nên các số hạng đó không đóng góp."
        t.close(e, ref["entropy"](p), tol=1e-5, what=f"entropy ở temperature = {temp} với token bị che")
    t.close(f(z, 0.0), F.one_hot(z.argmax(dim=-1), 8).float(), tol=1e-6, what="xác suất ở temperature = 0 khi có token bị che")


def test_entropy_values(user, ref):
    """Entropy (nat): phân phối đều trên 6 token là ln 6, one-hot là 0, (0.5, 0.5, 0, 0) là ln 2, và khớp lời giải chuẩn trên phân phối ngẫu nhiên"""
    h = need(user, "entropy")
    t.close(h(torch.full((2, 6), 1 / 6)), torch.full((2,), float(np.log(6))), tol=1e-5, what="entropy của phân phối đều trên 6 token (= ln 6)")
    onehot = F.one_hot(torch.tensor([2, 0]), 6).float()
    e = h(onehot)
    assert torch.isfinite(e).all(), "Entropy của phân phối one-hot ra nan: có xác suất bằng 0 thì 0·ln 0 phải tính là 0."
    t.close(e, torch.zeros(2), tol=1e-6, what="entropy của phân phối one-hot (= 0)")
    half = torch.tensor([[0.5, 0.5, 0.0, 0.0]])
    t.close(h(half), torch.full((1,), float(np.log(2))), tol=1e-6, what="entropy của (0.5, 0.5, 0, 0) (= ln 2)")
    p = F.softmax(_randn((4, 9), 5), dim=-1)
    t.close(h(p), ref["entropy"](p), tol=1e-5, what="entropy của phân phối ngẫu nhiên")


def test_large_logits(user, ref):
    """Logits rất lớn (hàng nghìn) vẫn ra xác suất hữu hạn và đúng, ở temperature 1 và rất nhỏ"""
    f = need(user, "temperature_probs")
    z = torch.tensor([[1000.0, 1001.0, 999.0], [-1000.0, -999.0, -1002.0]])
    for temp in [1.0, 0.01]:
        p = f(z, temp)
        assert torch.isfinite(p).all(), f"Ra nan hoặc inf với logits cỡ hàng nghìn ở temperature = {temp}: exp tràn số. Softmax ổn định trừ đi cái gì trước khi lấy exp?"
        t.close(p, ref["temperature_probs"](z, temp), tol=1e-6, what=f"xác suất với logits lớn ở temperature = {temp}")


def test_negative_temperature(user, ref):
    """temperature âm là vô nghĩa: raise ValueError"""
    f = need(user, "temperature_probs")
    z = _randn((2, 5), 6)
    for temp in [-1.0, -0.001]:
        try:
            f(z, temp)
        except ValueError:
            continue
        raise AssertionError(f"temperature = {temp} (âm) phải raise ValueError: chia cho số âm đảo thứ tự các token.")


def test_input_unchanged(user, ref):
    """Không sửa logits và xác suất của người gọi tại chỗ"""
    f, h = need(user, "temperature_probs"), need(user, "entropy")
    z = _randn((3, 5), 7)
    keep = z.clone()
    for temp in [2.0, 0.0]:
        f(z, temp)
        assert torch.equal(z, keep), f"temperature_probs đã sửa logits của người gọi tại chỗ (ở temperature = {temp}): hãy tạo tensor mới."
    p = F.softmax(z, dim=-1)
    keep_p = p.clone()
    h(p)
    assert torch.equal(p, keep_p), "entropy đã sửa xác suất của người gọi tại chỗ."
