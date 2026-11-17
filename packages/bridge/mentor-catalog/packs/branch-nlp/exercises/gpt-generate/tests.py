V, BS = 12, 6


def _g(seed):
    return torch.Generator().manual_seed(seed)


def _tokens(shape, seed):
    return torch.randint(0, V, shape, generator=_g(seed))


def _table():
    i = torch.arange(V, dtype=torch.float32).view(-1, 1)
    j = torch.arange(V, dtype=torch.float32).view(1, -1)
    return 3 * torch.sin(1.7 * (i + 1) * (j + 2) + 0.9 * j)


class _Toy(nn.Module):
    """Mô hình giả: logits ở vị trí t là trung bình các hàng bảng tra của token 0..t (chỉ nhìn quá khứ), thêm dropout trên logits.
    Ghi lại mỗi lần được gọi: (có đang ghi gradient, đang ở train, độ dài T)."""

    def __init__(self, dropout=0.0):
        super().__init__()
        self.block_size = BS
        self.register_buffer("table", _table())
        self.drop = nn.Dropout(dropout)
        self.calls = []

    def forward(self, idx, targets=None):
        B, T = idx.shape
        assert T <= self.block_size, f"Mô hình nhận chuỗi dài {T} > block_size = {self.block_size}: mỗi bước chỉ được đưa vào block_size token cuối."
        self.calls.append((torch.is_grad_enabled(), self.training, T))
        rows = self.table[idx]
        logits = rows.cumsum(dim=1) / torch.arange(1, T + 1, dtype=torch.float32).view(1, T, 1)
        return self.drop(logits), None


def _gen(f, model, idx, n, seed, **kw):
    if hasattr(model, "calls"):
        model.calls.clear()
    t.seed(seed)
    return f(model, idx.clone(), n, **kw)


def _greedy(idx, n):
    m = _Toy().eval()
    out = idx.clone()
    with torch.no_grad():
        for _ in range(n):
            logits = m(out[:, -BS:])[0][:, -1]
            out = torch.cat([out, logits.argmax(dim=-1, keepdim=True)], dim=1)
    return out


def _prompt():
    # xác định (không dùng random) để khoảng cách giữa hai logit lớn nhất luôn đủ rộng
    return (torch.arange(15).view(5, 3) * 8 + 2) % V


def test_output_shape(user, ref):
    """Trả về (B, T0 + max_new_tokens) kiểu số nguyên: T0 cột đầu là prompt, token mới nằm trong từ vựng, idx đầu vào không bị sửa"""
    f = need(user, "generate")
    m = _Toy()
    idx = _tokens((3, 4), 1)
    keep = idx.clone()
    t.seed(0)
    out = f(m, idx, 5)
    assert isinstance(out, torch.Tensor), "generate phải trả về một tensor (chuỗi token)."
    t.shape(out, (3, 9), what="kết quả với idx (3, 4) và max_new_tokens = 5")
    assert out.dtype == torch.long, f"Kết quả có kiểu {out.dtype}, cần kiểu số nguyên (torch.long): đó là chỉ số token."
    assert torch.equal(out[:, :4], keep), "4 cột đầu của kết quả phải đúng là prompt."
    assert int(out.min()) >= 0 and int(out.max()) < V, "Có token sinh ra nằm ngoài từ vựng [0, V)."
    assert torch.equal(idx, keep), "generate đã sửa idx của người gọi tại chỗ: hãy tạo tensor mới thay vì ghi đè."
    t.seed(0)
    zero = f(m, idx, 0)
    assert torch.equal(zero, keep), "max_new_tokens = 0 phải trả về đúng prompt."
    t.seed(0)
    one = f(m, idx[:1, :1], 1)
    t.shape(one, (1, 2), what="kết quả với prompt một token và max_new_tokens = 1")


def test_sampling(user, ref):
    """Cùng seed thì chuỗi sinh ra giống hệt lời giải chuẩn ở temperature 1.0 (mặc định), 0.7 và 2.5"""
    f, g = need(user, "generate"), ref["generate"]
    idx = _tokens((4, 3), 2)
    for temp, seed in [(1.0, 0), (0.7, 1), (2.5, 2)]:
        kw = {} if temp == 1.0 else {"temperature": temp}
        a = _gen(f, _Toy(), idx, 9, seed, **kw)
        b = _gen(g, _Toy(), idx, 9, seed, **kw)
        assert torch.equal(a, b), f"Chuỗi sinh ra ở temperature = {temp} khác chuỗi của lời giải chuẩn (cùng seed). Kiểm tra: logits lấy ở vị trí nào, chia cho temperature chưa, softmax theo trục nào, và lấy mẫu bằng torch.multinomial một lần mỗi bước."


def test_top_k_support(user, ref):
    """Với top_k = 3 mọi token sinh ra nằm trong 3 token có logit lớn nhất ở bước đó, và chuỗi giống lời giải chuẩn khi cùng seed"""
    f, g = need(user, "generate"), ref["generate"]
    idx = _tokens((48, 3), 3)
    a = _gen(f, _Toy(), idx, 8, 4, top_k=3)
    m = _Toy().eval()
    with torch.no_grad():
        for s in range(8):
            ctx = a[:, : 3 + s][:, -BS:]
            top = m(ctx)[0][:, -1].topk(3).indices
            new = a[:, 3 + s:4 + s]
            assert bool((top == new).any(dim=1).all()), f"Ở bước {s + 1} có token sinh ra nằm ngoài 3 token có logit lớn nhất: token bị loại phải có xác suất đúng 0 sau softmax. Bạn đặt logit của chúng bằng gì?"
    b = _gen(g, _Toy(), idx, 8, 4, top_k=3)
    assert torch.equal(a, b), "Các token đều nằm trong top-3 nhưng chuỗi khác lời giải chuẩn (cùng seed): ngưỡng loại phải là logit lớn thứ k của từng hàng."


def test_top_k_edges(user, ref):
    """top_k = 1 cho chuỗi greedy; top_k bằng hoặc lớn hơn cỡ từ vựng thì không loại token nào (kết quả như khi không dùng top_k)"""
    f = need(user, "generate")
    idx = _prompt()
    a = _gen(f, _Toy(), idx, 7, 6, top_k=1)
    assert torch.equal(a, _greedy(idx, 7)), "top_k = 1 phải cho đúng chuỗi greedy (mỗi bước chọn token có logit lớn nhất), dù seed nào."
    plain = _gen(f, _Toy(), idx, 7, 7)
    for k in [V, V + 5, 10 ** 6]:
        got = _gen(f, _Toy(), idx, 7, 7, top_k=k)
        assert torch.equal(got, plain), f"top_k = {k} không nhỏ hơn cỡ từ vựng V = {V} mà kết quả khác lúc không dùng top_k: khi đó không token nào được loại."


def test_low_temperature(user, ref):
    """Temperature rất nhỏ (1e-4) cho chuỗi greedy: phân phối dồn hết về token có logit lớn nhất"""
    f = need(user, "generate")
    idx = _prompt()
    want = _greedy(idx, 7)
    for seed in [0, 1]:
        got = _gen(f, _Toy(), idx, 7, seed, temperature=1e-4)
        assert torch.equal(got, want), "Với temperature = 1e-4 chuỗi sinh ra phải là chuỗi greedy: temperature nhỏ làm logits sau khi chia xa nhau hơn hay gần nhau hơn?"


def test_high_temperature(user, ref):
    """Temperature rất lớn (100) làm phân phối gần đều: 600 mẫu từ cùng một prompt phủ hết từ vựng"""
    f = need(user, "generate")
    idx = torch.zeros((600, 1), dtype=torch.long)
    out = _gen(f, _Toy(), idx, 1, 5, temperature=100.0)
    counts = torch.bincount(out[:, 1], minlength=V)
    assert int(counts.min()) >= 15, f"Với temperature = 100 mỗi token phải xuất hiện cỡ 50 lần trên 600 mẫu, nhưng số lần xuất hiện là {counts.tolist()}. Temperature lớn làm các logit sau khi chia xa nhau hơn hay gần nhau hơn?"


def test_context_crop(user, ref):
    """Chuỗi dài hơn block_size: mỗi bước chỉ đưa block_size token cuối vào mô hình (chuỗi ngắn thì đưa nguyên), kết quả khớp lời giải chuẩn"""
    f, g = need(user, "generate"), ref["generate"]
    m = _Toy()
    idx = _tokens((3, 4 * BS), 9)
    a = _gen(f, m, idx, 4, 10)
    lengths = [c[2] for c in m.calls]
    assert lengths == [BS] * 4, f"Mỗi bước phải đưa vào mô hình đúng {BS} token cuối của chuỗi (block_size), nhưng các lần gọi nhận độ dài {lengths}."
    b = _gen(g, _Toy(), idx, 4, 10)
    assert torch.equal(a, b), "Chuỗi khác lời giải chuẩn khi prompt dài hơn block_size: phải giữ token cuối (gần nhất), bỏ token đầu."
    m2 = _Toy()
    _gen(f, m2, _tokens((2, 2), 11), 3, 12)
    lengths = [c[2] for c in m2.calls]
    assert lengths == [2, 3, 4], f"Với prompt ngắn hơn block_size, mô hình phải nhận chuỗi hiện có nguyên vẹn mỗi bước, đúng một lần gọi mỗi bước, nhưng các lần gọi nhận độ dài {lengths}."


def test_eval_no_grad(user, ref):
    """Sinh ở chế độ eval (dropout tắt), không ghi đồ thị gradient, và chế độ train/eval của mô hình như cũ sau khi gọi"""
    f, g = need(user, "generate"), ref["generate"]
    idx = _tokens((4, 3), 12)
    m = _Toy(dropout=0.5).train()
    a = _gen(f, m, idx, 6, 13)
    assert m.calls and all(not c[1] for c in m.calls), "Lúc sinh văn bản mô hình đang ở chế độ train (dropout còn bật): phải chuyển sang eval."
    assert all(not c[0] for c in m.calls), "Lúc sinh văn bản mô hình vẫn đang ghi đồ thị gradient: đây là suy luận, không cần gradient (và sẽ tốn bộ nhớ)."
    assert m.training, "Mô hình đang ở chế độ train trước khi gọi nhưng sau generate lại ở eval: hãy trả về chế độ ban đầu."
    b = _gen(g, _Toy(dropout=0.5).train(), idx, 6, 13)
    assert torch.equal(a, b), "Chuỗi khác lời giải chuẩn khi mô hình có dropout (cùng seed): lúc sinh dropout phải tắt."
    e = _Toy(dropout=0.5).eval()
    _gen(f, e, idx, 2, 14)
    assert not e.training, "Mô hình đang ở eval trước khi gọi thì sau generate cũng phải ở eval."


def test_with_your_gpt(user, ref):
    """Chạy được trên GPT của chính bạn (bài gpt-mini) với prompt ngắn hơn rồi dài hơn block_size, khớp lời giải chuẩn, và mô hình vẫn ở chế độ train sau khi gọi"""
    f, g = need(user, "generate"), ref["generate"]
    t.seed(20)
    m = need(user, "GPT")(V, BS, 16, 4, 2)
    m.train()
    idx = _tokens((3, 4), 21)
    a = _gen(f, m, idx, 10, 22, temperature=0.8, top_k=5)
    t.shape(a, (3, 14), what="kết quả trên GPT với idx (3, 4) và max_new_tokens = 10")
    assert m.training, "Sau generate, GPT bị đổi sang chế độ eval: hãy trả về chế độ ban đầu."
    b = _gen(g, m, idx, 10, 22, temperature=0.8, top_k=5)
    assert torch.equal(a, b), "Trên GPT của bạn chuỗi khác lời giải chuẩn (cùng seed, cùng trọng số)."
