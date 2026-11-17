N_EVAL = 2048
SEED_EVAL = 777


def _model(user, name):
    m = user.get(name)
    assert isinstance(m, nn.Module), f"Chưa thấy biến toàn cục `{name}` (một nn.Module): chạy cell train và để mô hình đã fine-tune trong biến tên `{name}`."
    return m


def _adapter_names(model):
    return [n for n, _ in model.named_parameters() if n.split(".")[-1] in ("A", "B")]


def _loss_b(ref, model):
    return ref["eval_loss"](model, "B", n=N_EVAL, seed=SEED_EVAL)


def test_models_defined(user, ref):
    """Có hai biến model_full (GPT thường, không adapter) và model_lora (có adapter A, B); hai đối tượng riêng; forward ra logits đúng shape"""
    full, lora = _model(user, "model_full"), _model(user, "model_lora")
    assert full is not lora, "model_full và model_lora là cùng một đối tượng: hai mô hình phải riêng nhau (sao chép mô hình huấn luyện trước, đừng dùng chung)."
    assert not _adapter_names(full), "model_full đang chứa adapter A, B của LoRA: nó phải là mô hình thường fine-tune toàn bộ. Có phải bạn đã gắn LoRA vào chính mô hình dùng chung với bản đầy đủ?"
    assert _adapter_names(lora), "model_lora chưa có adapter nào (không tham số nào tên A hoặc B): gắn LoRA bằng add_lora của bạn."
    assert set(full.state_dict()) == set(ref["GPT"](*ref["GPT_CONFIG"]).state_dict()), "model_full có tên tham số khác một GPT thường: nó phải là GPT của bạn (bài gpt-mini)."
    x = ref["make_batch"]("B", 4, torch.Generator().manual_seed(1)).to(next(lora.parameters()).device)
    for name, m in [("model_full", full), ("model_lora", lora)]:
        with torch.no_grad():
            logits, _ = m(x)
        t.shape(logits, (4, ref["SEQ_LEN"], ref["VOCAB_SIZE"]), what=f"logits của {name}")


def test_weights_finite(user, ref):
    """Mọi tham số của hai mô hình hữu hạn: quá trình train không phát nổ thành NaN hoặc inf"""
    for name in ["model_full", "model_lora"]:
        bad = [n for n, p in _model(user, name).named_parameters() if not bool(torch.isfinite(p).all())]
        assert not bad, f"{name} có NaN hoặc inf ở {bad[:3]}: train bị phát nổ (learning rate bao nhiêu?)."


def test_lora_params(user, ref):
    """Đo lora_trainable_pct: phần trăm tham số của model_lora đang cần gradient; chỉ có A và B của adapter được học"""
    lora = _model(user, "model_lora")
    params = dict(lora.named_parameters())
    total = sum(p.numel() for p in params.values())
    trainable = sum(p.numel() for p in params.values() if p.requires_grad)
    t.report("lora_trainable_pct", 100.0 * trainable / total)
    others = sorted(n for n, p in params.items() if p.requires_grad and n.split(".")[-1] not in ("A", "B"))
    assert not others, f"model_lora còn học cả các tham số không phải adapter, ví dụ {others[:3]}: LoRA chỉ train A và B, mọi thứ khác phải đóng băng."


def test_lora_from_pretrained(user, ref):
    """Các trọng số đóng băng của model_lora giống hệt mô hình huấn luyện trước (PRETRAINED_STATE): adapter được gắn lên đúng mô hình đó, trọng số gốc không bị train"""
    state = user.get("PRETRAINED_STATE")
    assert isinstance(state, dict), "Chưa thấy PRETRAINED_STATE: bạn đã gọi pretrain() (phần cho sẵn của paper) để lấy mô hình huấn luyện trước chưa?"
    lora = _model(user, "model_lora")
    got = {n.replace(".base.", "."): v for n, v in lora.state_dict().items() if n.split(".")[-1] not in ("A", "B")}
    assert set(got) == set(state), f"Tên tham số của model_lora (sau khi bỏ adapter) khác mô hình huấn luyện trước: thiếu {sorted(set(state) - set(got))[:3]}, thừa {sorted(set(got) - set(state))[:3]}."
    changed = sorted(n for n, v in got.items() if not torch.equal(v.detach().cpu(), state[n].cpu()))
    assert not changed, f"Trọng số {changed[:3]} của model_lora khác mô hình huấn luyện trước: LoRA phải bắt đầu từ đúng mô hình do pretrain() trả về và không được sửa trọng số gốc (đóng băng)."


def test_losses_on_task_b(user, ref):
    """Đo loss_full, loss_lora, loss_ratio trên chuỗi kiểm tra mới của tác vụ B (và loss_before của mô hình huấn luyện trước), chỉ đo, không train"""
    full, lora = _model(user, "model_full"), _model(user, "model_lora")
    loss_full, loss_lora = _loss_b(ref, full), _loss_b(ref, lora)
    assert np.isfinite(loss_full) and np.isfinite(loss_lora), "Loss của model_full hoặc model_lora không hữu hạn."
    t.report("loss_full", loss_full)
    t.report("loss_lora", loss_lora)
    t.report("loss_ratio", loss_lora / loss_full)
    state = user.get("PRETRAINED_STATE")
    if isinstance(state, dict):
        base = ref["GPT"](*ref["GPT_CONFIG"])
        base.load_state_dict(state)
        t.report("loss_before", _loss_b(ref, base))
