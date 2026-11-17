V, BS, C, H, NL = 11, 8, 16, 4, 2
ATTN = ["attn.qkv", "attn.proj"]


def _g(seed):
    return torch.Generator().manual_seed(seed)


def _model(ref, seed=0):
    t.seed(seed)
    return ref["GPT"](V, BS, C, H, NL)


def _get(block, path):
    m = block
    for part in path.split("."):
        m = getattr(m, part)
    return m


def _tokens(shape, seed):
    return torch.randint(0, V, shape, generator=_g(seed))


def _total(model):
    return sum(p.numel() for p in model.parameters())


def _inject(user, ref, r=4, alpha=8.0, targets=None, seed=0):
    model = _model(ref, seed)
    before = _total(model)
    out = need(user, "add_lora")(model, r, alpha, ATTN if targets is None else targets)
    assert out is model, "add_lora phải sửa model tại chỗ và trả về chính model đó (return model)."
    return model, before


def test_replaces_targets(user, ref):
    """Mỗi khối: các đường dẫn trong targets thành LoRALinear (r, α đúng, mỗi chỗ một adapter riêng), các lớp khác giữ nguyên nn.Linear"""
    lora_cls = need(user, "LoRALinear")
    for targets in [ATTN, ["mlp.0", "mlp.2"], ["attn.qkv"]]:
        model, _ = _inject(user, ref, targets=targets, seed=1)
        seen = []
        for i, block in enumerate(model.blocks):
            for path in ["attn.qkv", "attn.proj", "mlp.0", "mlp.2"]:
                m = _get(block, path)
                if path in targets:
                    assert isinstance(m, lora_cls), f"blocks[{i}].{path} phải là một LoRALinear (của bạn), nhưng là {type(m).__name__}."
                    assert tuple(m.A.shape)[0] == 4 and abs(m.scale - 2.0) < 1e-9, f"blocks[{i}].{path}: r = {m.A.shape[0]}, scale = {m.scale}; cần r = 4 và α/r = 2.0."
                    seen.append(m)
                else:
                    assert type(m) is nn.Linear, f"blocks[{i}].{path} không nằm trong targets nhưng đã bị đổi thành {type(m).__name__}."
        assert len({id(m.A) for m in seen}) == len(seen) and len({id(m.B) for m in seen}) == len(seen), "Các chỗ gắn đang dùng chung một adapter: mỗi lớp được thay phải có LoRALinear riêng (A, B riêng)."
    assert type(model.head) is nn.Linear, "head không nằm trong targets (targets chỉ tính từ mỗi khối) nhưng đã bị đổi."


def test_only_adapters_train(user, ref):
    """Chỉ các tham số A và B của adapter cần gradient; embedding, LayerNorm, head, các Linear khác và trọng số gốc đều đóng băng"""
    model, _ = _inject(user, ref, seed=2)
    trainable = sorted(n for n, p in model.named_parameters() if p.requires_grad)
    want = sorted(f"blocks.{i}.{path}.{ab}" for i in range(NL) for path in ATTN for ab in ["A", "B"])
    assert trainable == want, f"Tham số đang cần gradient: {trainable[:6]}{' ...' if len(trainable) > 6 else ''}; cần đúng {len(want)} tham số A và B của các adapter ({want[:2]} ...)."
    frozen_bad = [n for n, p in model.named_parameters() if not p.requires_grad and n.split(".")[-1] in ("A", "B")]
    assert not frozen_bad, f"Các adapter {frozen_bad[:2]} bị đóng băng: adapter phải học được. Đóng băng \"tất cả\" nên xảy ra lúc nào so với lúc tạo adapter?"


def test_output_unchanged(user, ref):
    """Ngay sau khi gắn LoRA, logits và loss của mô hình không đổi (mọi B = 0), với cả attn và mlp làm đích"""
    idx, targets = _tokens((3, 7), 3), _tokens((3, 7), 4)
    for tg in [ATTN, ["mlp.0", "mlp.2"]]:
        model = _model(ref, seed=5)
        with torch.no_grad():
            want_logits, want_loss = model(idx, targets)
        model = need(user, "add_lora")(model, 4, 8.0, tg)
        with torch.no_grad():
            logits, loss = model(idx, targets)
        t.close(logits, want_logits, tol=1e-5, what=f"logits ngay sau khi gắn LoRA vào {tg} (adapter mới phải chưa làm đổi mô hình)")
        t.close(loss, want_loss, tol=1e-5, what="loss ngay sau khi gắn LoRA")


def test_count_params(user, ref):
    """count_params: (trainable, total) là hai số nguyên; trước khi gắn thì bằng nhau; sau khi gắn khớp công thức r·(in + out) của từng lớp được gắn"""
    count = need(user, "count_params")
    model = _model(ref, seed=6)
    n = _total(model)
    got = count(model)
    assert isinstance(got, tuple) and len(got) == 2 and all(isinstance(v, int) for v in got), f"count_params phải trả về một tuple (trainable, total) gồm hai số nguyên, nhưng trả về {got!r}."
    assert got == (n, n), f"Mô hình chưa gắn gì có {n} tham số, tất cả đều học được, nhưng count_params trả về {got}."
    # (r, targets, số tham số adapter mỗi khối): qkv là Linear(C, 3C), proj là Linear(C, C), mlp.0 là Linear(C, 4C), mlp.2 là Linear(4C, C)
    for r, targets, per_block in [(4, ATTN, 4 * (C + 3 * C) + 4 * (C + C)), (2, ["mlp.0", "mlp.2"], 2 * (C + 4 * C) + 2 * (4 * C + C)), (1, ["attn.qkv"], 1 * (C + 3 * C))]:
        model, before = _inject(user, ref, r=r, targets=targets, seed=7)
        trainable, total = count(model)
        assert trainable == NL * per_block, f"Với r = {r}, targets = {targets}: trainable = {trainable}, cần {NL * per_block} (mỗi lớp Linear(in, out) được gắn góp r·(in + out))."
        assert total == before + NL * per_block, f"Với r = {r}, targets = {targets}: total = {total}, cần {before + NL * per_block} (tham số gốc, đóng băng, cộng thêm các A, B)."
        assert total == _total(model), "total phải đếm mọi tham số của model (cả tham số đóng băng và cả A, B)."


def test_frozen_stay_frozen_in_training(user, ref):
    """Sau vài bước optimizer trên các tham số cần gradient: mọi tham số đóng băng y nguyên, còn A và B đã đổi"""
    model, _ = _inject(user, ref, seed=8)
    idx, targets = _tokens((4, 8), 9), _tokens((4, 8), 10)
    snap = {n: p.detach().clone() for n, p in model.named_parameters()}
    params = [p for p in model.parameters() if p.requires_grad]
    assert params, "Không có tham số nào cần gradient."
    opt = torch.optim.SGD(params, lr=0.05)
    for _ in range(3):
        opt.zero_grad()
        model(idx, targets)[1].backward()
        opt.step()
    for n, p in model.named_parameters():
        if n.split(".")[-1] in ("A", "B"):
            continue
        assert torch.equal(p.detach(), snap[n]), f"Tham số {n} bị optimizer đổi: nó phải đóng băng."
    moved = [n for n, p in model.named_parameters() if n.split(".")[-1] == "B" and not torch.equal(p.detach(), snap[n])]
    assert len(moved) == NL * len(ATTN), f"Chỉ {len(moved)}/{NL * len(ATTN)} ma trận B đã đổi sau khi train: adapter nào không học?"


def test_forward_matches_manual(user, ref):
    """Sau khi A, B khác 0: logits khớp đúng công thức W + (α/r)·B·A áp lên các lớp targets (chép adapter vào bản chuẩn)"""
    model, _ = _inject(user, ref, seed=11)
    lora_cls = need(user, "LoRALinear")
    gen = _g(12)
    with torch.no_grad():
        for m in model.modules():
            if isinstance(m, lora_cls):
                m.B.copy_(torch.randn(m.B.shape, generator=gen) * 0.3)
    plain = _model(ref, seed=11)
    with torch.no_grad():
        for i, block in enumerate(model.blocks):
            for path in ATTN:
                m, base = _get(block, path), _get(plain.blocks[i], path)
                base.weight.copy_(m.base.weight + m.scale * m.B @ m.A)
    idx = _tokens((3, 6), 13)
    with torch.no_grad():
        t.close(model(idx)[0], plain(idx)[0], tol=1e-4, what="logits của mô hình gắn LoRA so với mô hình thường có trọng số đã gộp")
