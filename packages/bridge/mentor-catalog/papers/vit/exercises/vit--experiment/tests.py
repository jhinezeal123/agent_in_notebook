N_EVAL = 2000
N_TIME = 256


def _model(user, name):
    m = user.get(name)
    assert isinstance(m, nn.Module), f"Chưa thấy biến toàn cục `{name}` (một nn.Module): chạy cell train và để ViT đã train trong biến tên `{name}`."
    assert hasattr(m, "pos_embed") and hasattr(m, "blocks"), f"`{name}` chưa phải ViT của bạn (thiếu pos_embed hoặc blocks): nó phải được dựng bằng make_vit (bài vit--classifier)."
    return m


def _device(model):
    return next(model.parameters()).device


def _tokens(model):
    return int(model.pos_embed.shape[1]) - 1


def _config(model):
    return (int(model.pos_embed.shape[-1]), len(model.blocks), int(model.blocks[0].attn.num_heads))


def test_models_defined(user, ref):
    """Có hai biến model_p_small và model_p_large (ViT riêng nhau) gọi được với ảnh (B, 1, 28, 28) và trả logits (B, 10)"""
    small, large = _model(user, "model_p_small"), _model(user, "model_p_large")
    assert small is not large, "model_p_small và model_p_large là cùng một đối tượng: hai mô hình phải riêng nhau (dựng hai lần, train hai lần)."
    x = torch.randn(2, 1, 28, 28, generator=torch.Generator().manual_seed(1))
    for name, m in [("model_p_small", small), ("model_p_large", large)]:
        was_training = m.training
        m.eval()
        try:
            with torch.no_grad():
                out = m(x.to(_device(m)))
        finally:
            m.train(was_training)
        t.shape(out, (2, 10), what=f"logits của {name} với ảnh (2, 1, 28, 28)")


def test_weights_finite(user, ref):
    """Mọi tham số của hai mô hình hữu hạn: quá trình train không phát nổ thành NaN hoặc inf"""
    for name in ["model_p_small", "model_p_large"]:
        bad = [n for n, p in _model(user, name).named_parameters() if not bool(torch.isfinite(p).all())]
        assert not bad, f"{name} có NaN hoặc inf ở {bad[:3]}: train bị phát nổ (learning rate bao nhiêu, có lịch giảm dần không?)."


def test_differ_only_in_patch_size(user, ref):
    """Hai mô hình cùng dim, depth và số head (chỉ khác patch size), và model_p_small có nhiều token hơn model_p_large (patch nhỏ hơn)"""
    small, large = _model(user, "model_p_small"), _model(user, "model_p_large")
    assert _config(small) == _config(large), f"model_p_small có (dim, depth, head) = {_config(small)}, model_p_large có {_config(large)}: phép so sánh chỉ có nghĩa khi hai mô hình chỉ khác patch size."
    n_small, n_large = _tokens(small), _tokens(large)
    assert n_small > n_large, f"model_p_small có {n_small} token, model_p_large có {n_large}: patch size NHỎ cho NHIỀU token hơn, nên model_p_small phải là mô hình có patch nhỏ. Có phải bạn đã đặt nhầm hai tên?"


def test_accuracy_and_cost(user, ref):
    """Đo acc_p_small, acc_p_large (2000 ảnh test MNIST mô hình chưa thấy), tokens_*, ms_* (thời gian forward mỗi ảnh) và attn_cost_ratio, chỉ đo, không train; cả hai mô hình đã học (accuracy > 0,5)"""
    small, large = _model(user, "model_p_small"), _model(user, "model_p_large")
    x_te, y_te = ref["load_mnist"](N_EVAL, train=False)
    acc_small = ref["evaluate"](small, x_te, y_te)
    acc_large = ref["evaluate"](large, x_te, y_te)
    n_small, n_large = _tokens(small), _tokens(large)
    t.report("acc_p_small", acc_small)
    t.report("acc_p_large", acc_large)
    t.report("tokens_p_small", n_small)
    t.report("tokens_p_large", n_large)
    t.report("ms_p_small", ref["ms_per_image"](small, x_te[:N_TIME]))
    t.report("ms_p_large", ref["ms_per_image"](large, x_te[:N_TIME]))
    t.report("attn_cost_ratio", ((n_small + 1) / (n_large + 1)) ** 2)
    assert acc_small > 0.5, f"model_p_small chỉ đúng {acc_small:.1%} trên ảnh test (đoán bừa là 10%): đã train nó chưa, và loss có giảm không?"
    assert acc_large > 0.5, f"model_p_large chỉ đúng {acc_large:.1%} trên ảnh test (đoán bừa là 10%): đã train nó chưa? Hai mô hình được train cùng cách."
