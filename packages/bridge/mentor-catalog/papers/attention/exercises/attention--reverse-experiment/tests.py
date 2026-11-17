N_EVAL = 512


def _model(user):
    model = user.get("model")
    assert isinstance(model, nn.Module), "Chưa thấy biến toàn cục `model` (một nn.Module): chạy cell train và để mô hình đã train trong biến tên model."
    return model


def _measure(user, ref, length, n, seed):
    """Giải n chuỗi `length` chữ số bằng greedy_decode: (tỷ lệ token đúng, tỷ lệ chuỗi đúng hoàn toàn)."""
    model = _model(user)
    src, _, want = ref["make_batch"](n, length, torch.Generator().manual_seed(seed))
    got = ref["greedy_decode"](model, src, length + 1)
    same = got == want
    return float(same.float().mean()), float(same.all(dim=1).float().mean())


def test_model_defined(user, ref):
    """Biến model là một Transformer tự dựng (không phải nn.Transformer) và forward ra logits (B, T, vocab)"""
    model = _model(user)
    assert not isinstance(model, nn.Transformer), "model là nn.Transformer của PyTorch: thí nghiệm này train Transformer bạn tự ráp ở bài trước."
    assert hasattr(model, "enc_layers") and hasattr(model, "dec_layers"), "model chưa có enc_layers và dec_layers: nó phải là Transformer của bạn (bài attention--transformer)."
    n, length = 4, ref["SEQ_LEN"]
    src, tgt_in, _ = ref["make_batch"](n, length, torch.Generator().manual_seed(1))
    was_training = model.training
    model.eval()
    try:
        with torch.no_grad():
            device = next(model.parameters()).device
            out = model(src.to(device), tgt_in.to(device))
    finally:
        model.train(was_training)
    t.shape(out, (n, length + 1, ref["VOCAB_SIZE"]), what=f"logits của model với src ({n}, {length}) và tgt_in ({n}, {length + 1})")


def test_weights_finite(user, ref):
    """Mọi tham số của model hữu hạn: quá trình train không phát nổ thành NaN hoặc inf"""
    model = _model(user)
    bad = [name for name, p in model.named_parameters() if not bool(torch.isfinite(p).all())]
    assert not bad, f"Các tham số này có NaN hoặc inf: {bad[:3]}. Train bị phát nổ: learning rate đỉnh bao nhiêu, warmup mấy bước?"


def test_reverse_eight(user, ref):
    """Trên 512 chuỗi 8 chữ số mới, greedy_decode đảo đúng: đo token_acc và exact_match"""
    acc, exact = _measure(user, ref, ref["SEQ_LEN"], N_EVAL, seed=2024)
    t.report("token_acc", acc)
    t.report("exact_match", exact)


def test_longer_than_training(user, ref):
    """Trên chuỗi dài 12 (lúc train chỉ thấy dài 8): đo token_acc_len12, chỉ báo, không có ngưỡng"""
    try:
        acc, _ = _measure(user, ref, 12, 256, seed=2025)
    except Exception:
        acc = 0.0
    t.report("token_acc_len12", acc)
