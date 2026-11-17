N_EVAL = 2000


def _model(user, name):
    m = user.get(name)
    assert isinstance(m, nn.Module), f"Chưa thấy biến toàn cục `{name}` (một nn.Module): chạy cell train và để mạng đã train trong biến tên `{name}`."
    return m


def _device(model):
    return next(model.parameters()).device


def _weighted_layers(m):
    """Số lớp có trọng số theo cách đếm của paper: conv 3x3 và Linear (conv 1x1 của đường tắt projection không tính)."""
    return sum(1 for mod in m.modules() if (isinstance(mod, nn.Conv2d) and mod.kernel_size == (3, 3)) or isinstance(mod, nn.Linear))


def _n_params(m):
    return sum(p.numel() for p in m.parameters())


def test_models_defined(user, ref):
    """Có hai biến model_res và model_plain (nn.Module riêng nhau) gọi được với ảnh (B, 3, 32, 32) và trả logits (B, 10)"""
    res, plain = _model(user, "model_res"), _model(user, "model_plain")
    assert res is not plain, "model_res và model_plain là cùng một đối tượng: hai mạng phải riêng nhau (dựng hai lần, train hai lần)."
    x = torch.randn(2, 3, 32, 32, generator=torch.Generator().manual_seed(1))
    for name, m in [("model_res", res), ("model_plain", plain)]:
        was_training = m.training
        m.eval()
        try:
            with torch.no_grad():
                out = m(x.to(_device(m)))
        finally:
            m.train(was_training)
        t.shape(out, (2, 10), what=f"logits của {name} với ảnh (2, 3, 32, 32)")


def test_weights_finite(user, ref):
    """Mọi tham số của hai mạng hữu hạn: quá trình train không phát nổ thành NaN hoặc inf"""
    for name in ["model_res", "model_plain"]:
        bad = [n for n, p in _model(user, name).named_parameters() if not bool(torch.isfinite(p).all())]
        assert not bad, f"{name} có NaN hoặc inf ở {bad[:3]}: train bị phát nổ (learning rate bao nhiêu, có lịch giảm dần không?)."


def test_plain_differs_from_residual(user, ref):
    """Hai mạng cùng độ sâu; model_plain ít tham số hơn model_res vì không có projection của đường tắt (hai mạng khác nhau đúng ở đường tắt); đo depth"""
    res, plain = _model(user, "model_res"), _model(user, "model_plain")
    d_res, d_plain = _weighted_layers(res), _weighted_layers(plain)
    t.report("depth", d_res)
    assert d_res == d_plain, f"model_res có {d_res} lớp có trọng số, model_plain có {d_plain}: so sánh chỉ có nghĩa khi hai mạng cùng độ sâu, chỉ khác đường tắt."
    p_res, p_plain = _n_params(res), _n_params(plain)
    assert p_plain < p_res, f"model_plain có {p_plain:,} tham số, model_res có {p_res:,}: mạng plain không có projection của đường tắt nên phải ít hơn. Bạn có dựng model_plain với công tắc shortcut=False không?"


def test_accuracy_and_train_error(user, ref):
    """Đo acc_res, acc_plain (2000 ảnh test CIFAR-10 mô hình chưa thấy) và train_err_res, train_err_plain (2000 ảnh đầu tập train), eval, không train; cả hai mạng đã học (acc > 0,25)"""
    res, plain = _model(user, "model_res"), _model(user, "model_plain")
    x_te, y_te = ref["load_cifar10"](N_EVAL, train=False)
    x_tr, y_tr = ref["load_cifar10"](N_EVAL, train=True)
    acc_res, _ = ref["evaluate"](res, x_te, y_te)
    acc_plain, _ = ref["evaluate"](plain, x_te, y_te)
    _, err_res = ref["evaluate"](res, x_tr, y_tr)
    _, err_plain = ref["evaluate"](plain, x_tr, y_tr)
    t.report("acc_res", acc_res)
    t.report("acc_plain", acc_plain)
    t.report("train_err_res", err_res)
    t.report("train_err_plain", err_plain)
    assert acc_res > 0.25, f"model_res chỉ đúng {acc_res:.1%} trên ảnh test (đoán bừa là 10%): đã train nó chưa, và loss có giảm không?"
    assert acc_plain > 0.25, f"model_plain chỉ đúng {acc_plain:.1%} trên ảnh test (đoán bừa là 10%): đã train nó chưa? Mạng plain được train cùng cách với mạng residual."
