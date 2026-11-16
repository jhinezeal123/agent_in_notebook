def _model(seed, p=0.5):
    torch.manual_seed(seed)
    return nn.Sequential(nn.Linear(4, 16), nn.ReLU(), nn.Dropout(p), nn.Linear(16, 3))


def _batches(seed, sizes=(10, 10, 2)):
    g = torch.Generator().manual_seed(seed)
    return [(torch.randn(n, 4, generator=g), torch.randint(0, 3, (n,), generator=g)) for n in sizes]


def _train(fn, model, data, seed):
    opt = torch.optim.SGD(model.parameters(), lr=0.5)
    t.seed(seed)
    return fn(model, data, opt, nn.CrossEntropyLoss())


def _same_params(m_user, m_ref, hint):
    for (name, p), q in zip(m_user.named_parameters(), m_ref.parameters()):
        diff = float((p.detach() - q.detach()).abs().max())
        assert diff < 1e-5, f"Tham số {name} sau một epoch lệch lời giải chuẩn {diff:.2e}: {hint}"


def test_train_matches_ref(user, ref):
    """train_epoch: tham số sau một epoch và loss trả về khớp lời giải chuẩn"""
    f = need(user, "train_epoch")
    m_user, m_ref = _model(0), _model(0)
    data = _batches(1)
    got = _train(f, m_user, data, seed=2)
    want = _train(ref["train_epoch"], m_ref, data, seed=2)
    assert isinstance(got, float), f"train_epoch trả về {type(got).__name__}, cần một số Python (float)."
    _same_params(m_user, m_ref, "mỗi bước có chỉ dùng gradient của đúng batch đó không?")
    assert abs(got - want) < 1e-5, f"Loss trả về {got:.5f}, cần {want:.5f}: trung bình theo mẫu, và batch cuối nhỏ hơn các batch khác."


def test_train_mode(user, ref):
    """train_epoch train với dropout bật, kể cả khi model đang ở chế độ eval"""
    f = need(user, "train_epoch")
    m_user, m_ref = _model(3), _model(3)
    m_user.eval()
    m_ref.eval()
    data = _batches(4)
    got = _train(f, m_user, data, seed=5)
    want = _train(ref["train_epoch"], m_ref, data, seed=5)
    assert m_user.training, "Model được đưa vào ở chế độ eval và vẫn ở chế độ eval sau train_epoch."
    _same_params(m_user, m_ref, "lúc train, dropout có đang chạy không?")
    assert abs(float(got) - want) < 1e-5, f"Loss trả về {float(got):.5f}, cần {want:.5f}."


def test_eval_matches_ref(user, ref):
    """evaluate: loss và accuracy khớp lời giải chuẩn, tham số không đổi"""
    f = need(user, "evaluate")
    m_user, m_ref = _model(6), _model(6)
    data = _batches(7)
    before = [p.detach().clone() for p in m_user.parameters()]
    t.seed(8)
    res = f(m_user, data, nn.CrossEntropyLoss())
    t.seed(8)
    want_loss, want_acc = ref["evaluate"](m_ref, data, nn.CrossEntropyLoss())
    assert isinstance(res, (tuple, list)) and len(res) == 2, "evaluate phải trả về (loss, accuracy)."
    loss, acc = res
    assert isinstance(loss, float) and isinstance(acc, float), f"loss và accuracy phải là số Python (float), đang là {type(loss).__name__} và {type(acc).__name__}."
    assert 0.0 <= acc <= 1.0, f"Accuracy = {acc}, cần là một tỉ lệ trong [0, 1]."
    assert abs(loss - want_loss) < 1e-5, f"Loss = {loss:.5f}, cần {want_loss:.5f}: mô hình có đang ở đúng chế độ khi đánh giá? Trung bình có theo mẫu không?"
    assert abs(acc - want_acc) < 1e-9, f"Accuracy = {acc:.4f}, cần {want_acc:.4f}."
    for p, b in zip(m_user.parameters(), before):
        assert torch.equal(p.detach(), b), "evaluate làm thay đổi tham số."
    assert all(p.grad is None for p in m_user.parameters()), "evaluate để lại .grad trên tham số."


def test_eval_no_graph(user, ref):
    """evaluate không xây đồ thị autograd"""
    f = need(user, "evaluate")
    seen = []

    def loss_fn(logits, y):
        seen.append(torch.is_grad_enabled() or logits.requires_grad)
        return F.cross_entropy(logits, y)

    f(_model(9), _batches(10), loss_fn)
    assert seen, "evaluate không gọi loss_fn."
    assert not any(seen), "Lúc đánh giá, PyTorch vẫn đang ghi lại đồ thị để tính gradient."


def test_eval_deterministic(user, ref):
    """evaluate tất định: gọi hai lần ra cùng một kết quả"""
    f = need(user, "evaluate")
    model = _model(11)
    data = _batches(12, sizes=(16, 16))
    t.seed(13)
    a = f(model, data, nn.CrossEntropyLoss())
    b = f(model, data, nn.CrossEntropyLoss())
    assert isinstance(a, (tuple, list)) and len(a) == 2, "evaluate phải trả về (loss, accuracy)."
    assert [float(v) for v in a] == [float(v) for v in b], "Gọi evaluate hai lần trên cùng model và dữ liệu mà ra hai kết quả khác nhau."
