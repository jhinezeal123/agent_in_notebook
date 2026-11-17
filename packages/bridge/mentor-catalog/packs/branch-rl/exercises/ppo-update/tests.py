class _TinyPolicy(nn.Module):
    def __init__(self, d=4, n_actions=3, hidden=8):
        super().__init__()
        self.body = nn.Linear(d, hidden)
        self.pi = nn.Linear(hidden, n_actions)
        self.v = nn.Linear(hidden, 1)
        self.seen = []

    def forward(self, x):
        self.seen.append(x[:, 0].detach().clone())
        h = torch.tanh(self.body(x))
        return self.pi(h), self.v(h).squeeze(-1)


class _CountingSGD(torch.optim.SGD):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.n_steps = 0

    def step(self, *args, **kwargs):
        self.n_steps += 1
        return super().step(*args, **kwargs)


def _policy(seed=0):
    t.seed(seed)
    return _TinyPolicy()


def _make_batch(policy, n=12, seed=0, shift=0.4, ret_scale=3.0, zero_adv=False):
    """obs ngẫu nhiên; old_logp = logp hiện tại của policy trừ một nhiễu nhỏ (nên tỉ số khác 1 một chút)."""
    g = torch.Generator().manual_seed(seed)
    obs = torch.randn(n, 4, generator=g)
    actions = torch.randint(0, 3, (n,), generator=g)
    with torch.no_grad():
        logits, _ = policy(obs)
        logp = torch.log_softmax(logits, dim=-1).gather(1, actions.unsqueeze(1)).squeeze(1)
    policy.seen = []
    old_logp = logp - shift * torch.randn(n, generator=g)
    adv = torch.zeros(n) if zero_adv else 2.0 * torch.randn(n, generator=g)
    returns = ret_scale * torch.randn(n, generator=g)
    return {"obs": obs, "actions": actions, "old_logp": old_logp, "advantages": adv, "returns": returns}


def _clone(batch):
    return {k: v.clone() for k, v in batch.items()}


def _params(policy):
    return [p.detach().clone() for p in policy.parameters()]


def _entropy(policy, obs):
    with torch.no_grad():
        logits, _ = policy(obs)
        lp = torch.log_softmax(logits, dim=-1)
        out = -(lp.exp() * lp).sum(dim=-1).mean()
    policy.seen = []
    return float(out)


def _run(f, policy, optimizer, batch, seed=7, clip_eps=0.2, vf_coef=0.5, ent_coef=0.01, epochs=2, minibatch_size=5, **kw):
    return f(policy, optimizer, batch, clip_eps, vf_coef, ent_coef, epochs, minibatch_size, torch.Generator().manual_seed(seed), **kw)


def test_optimizer_step_count(user, ref):
    """optimizer.step() được gọi đúng epochs x (số minibatch) lần, kể cả khi minibatch cuối nhỏ hơn hoặc minibatch_size lớn hơn dữ liệu"""
    f = need(user, "ppo_update")
    for n, mb, epochs, want in [(10, 4, 3, 9), (8, 8, 2, 2), (5, 100, 4, 4), (9, 3, 1, 3), (7, 2, 2, 8)]:
        policy = _policy(1)
        opt = _CountingSGD(policy.parameters(), lr=0.01)
        _run(f, policy, opt, _make_batch(policy, n, 1), epochs=epochs, minibatch_size=mb)
        assert opt.n_steps == want, (
            f"N = {n}, minibatch_size = {mb}, epochs = {epochs}: mỗi epoch có {want // epochs} minibatch nên cần {want} lần optimizer.step(); bạn gọi {opt.n_steps} lần."
        )


def test_each_sample_once_per_epoch(user, ref):
    """Mỗi epoch dùng mọi mẫu đúng một lần (qua các minibatch), policy được gọi đúng một lần mỗi minibatch"""
    f = need(user, "ppo_update")
    n, mb, epochs = 10, 4, 3
    policy = _policy(2)
    batch = _make_batch(policy, n, 2)
    batch["obs"][:, 0] = torch.arange(n, dtype=torch.float32)
    policy.seen = []
    _run(f, policy, torch.optim.SGD(policy.parameters(), lr=1e-4), batch, epochs=epochs, minibatch_size=mb)
    per_epoch = 3
    assert len(policy.seen) == per_epoch * epochs, (
        f"N = 10, minibatch_size = 4, 3 epoch: cần {per_epoch * epochs} lần gọi policy (mỗi minibatch một lần), bạn gọi {len(policy.seen)} lần. "
        f"Bạn có gọi policy ngoài vòng minibatch, hoặc nhiều lần trong một minibatch không?"
    )
    for e in range(epochs):
        ids = torch.cat(policy.seen[e * per_epoch:(e + 1) * per_epoch])
        got = sorted(int(x) for x in ids)
        assert got == list(range(n)), f"Epoch {e + 1}: các mẫu được dùng là {got}, cần mỗi mẫu 0..{n - 1} đúng một lần (một lần xáo trộn rồi chia nhóm)."


def test_shuffle_is_deterministic_and_fresh_each_epoch(user, ref):
    """Thứ tự xáo trộn do generator quyết định (cùng seed cùng kết quả, khác seed khác kết quả) và đổi giữa các epoch"""
    f = need(user, "ppo_update")
    results = []
    for seed in (5, 5, 6):
        policy = _policy(3)
        _run(f, policy, torch.optim.SGD(policy.parameters(), lr=0.1), _make_batch(policy, 12, 3), seed=seed, epochs=2, minibatch_size=4)
        results.append(_params(policy))
    for a, b in zip(results[0], results[1]):
        assert torch.equal(a, b), "Cùng generator (cùng seed) mà kết quả khác nhau: bạn có dùng nguồn ngẫu nhiên nào ngoài generator truyền vào không?"
    diff = max(float((a - b).abs().max()) for a, b in zip(results[0], results[2]))
    assert diff > 1e-6, "Seed khác nhau cho đúng cùng một kết quả: thứ tự minibatch có thật sự dùng generator không?"
    policy = _policy(4)
    batch = _make_batch(policy, 8, 4)
    batch["obs"][:, 0] = torch.arange(8, dtype=torch.float32)
    policy.seen = []
    _run(f, policy, torch.optim.SGD(policy.parameters(), lr=1e-4), batch, seed=9, epochs=6, minibatch_size=8)
    orders = [tuple(int(x) for x in policy.seen[i]) for i in range(len(policy.seen))]
    assert len(set(orders)) > 1, "Mọi epoch duyệt các mẫu theo cùng một thứ tự: cần xáo trộn lại ở mỗi epoch."


def test_matches_reference(user, ref):
    """Sau cập nhật, mọi tham số và các số thống kê khớp lời giải chuẩn (SGD và Adam, nhiều epoch, minibatch cuối nhỏ hơn)"""
    f = need(user, "ppo_update")
    cases = [
        ("sgd", dict(lr=0.05), dict(epochs=2, minibatch_size=5, vf_coef=0.5, ent_coef=0.01, clip_eps=0.2)),
        ("sgd", dict(lr=0.1), dict(epochs=3, minibatch_size=4, vf_coef=1.0, ent_coef=0.0, clip_eps=0.1)),
        ("adam", dict(lr=0.003), dict(epochs=2, minibatch_size=6, vf_coef=0.25, ent_coef=0.05, clip_eps=0.3)),
    ]
    for kind, opt_kw, kw in cases:
        pu, pr = _policy(5), _policy(5)
        bu, br = _make_batch(pu, 12, 5), _make_batch(pr, 12, 5)
        make = (lambda p: torch.optim.SGD(p.parameters(), **opt_kw)) if kind == "sgd" else (lambda p: torch.optim.Adam(p.parameters(), **opt_kw))
        got = _run(f, pu, make(pu), bu, seed=11, **kw)
        want = _run(ref["ppo_update"], pr, make(pr), br, seed=11, **kw)
        tol = 1e-4 if kind == "sgd" else 1e-3
        for name, a, b in zip(["body.weight", "body.bias", "pi.weight", "pi.bias", "v.weight", "v.bias"], pu.parameters(), pr.parameters()):
            t.close(a, b, tol=tol, what=f"tham số {name} sau cập nhật ({kind}, {kw})")
        for key in ("loss", "clip_fraction", "approx_kl"):
            assert key in got, f"Kết quả trả về thiếu khóa \"{key}\" (có: {sorted(got)})."
            t.close(float(got[key]), float(want[key]), tol=1e-3, what=f"thống kê {key} ({kind}, {kw})")


def test_entropy_bonus_sign(user, ref):
    """Bonus entropy làm policy khám phá nhiều hơn (entropy tăng); ent_coef = 0 thì không có tác dụng"""
    f = need(user, "ppo_update")
    policy = _policy(6)
    with torch.no_grad():
        policy.pi.bias.copy_(torch.tensor([3.0, 0.0, 0.0]))
    batch = _make_batch(policy, 12, 6, zero_adv=True)
    batch["old_logp"] = batch["old_logp"].clone()
    batch["returns"] = torch.zeros(12)
    before = _entropy(policy, batch["obs"])
    _run(f, policy, torch.optim.SGD(policy.parameters(), lr=0.5), batch, vf_coef=0.0, ent_coef=1.0, epochs=6, minibatch_size=12)
    after = _entropy(policy, batch["obs"])
    assert after > before + 0.05, (
        f"Chỉ còn bonus entropy (advantage = 0, vf_coef = 0, ent_coef = 1): policy đang gần như chắc chắn một hành động, sau cập nhật entropy phải TĂNG; "
        f"entropy đi từ {before:.3f} sang {after:.3f}. Bonus entropy mang dấu gì trong loss mà optimizer đang giảm?"
    )
    policy = _policy(6)
    batch = _make_batch(policy, 12, 6, zero_adv=True)
    batch["returns"] = torch.zeros(12)
    saved = _params(policy)
    _run(f, policy, torch.optim.SGD(policy.parameters(), lr=0.5), batch, vf_coef=0.0, ent_coef=0.0, epochs=3, minibatch_size=6)
    for a, b in zip(saved, _params(policy)):
        assert torch.equal(a, b), "ent_coef = 0, vf_coef = 0, advantage = 0: loss không có gradient nào, tham số không được đổi. Bạn có nhân ent_coef vào bonus entropy không?"


def test_value_loss_pulls_value_to_returns(user, ref):
    """Value loss kéo value về returns (không phải về advantage hay xa returns), có nhân vf_coef"""
    f = need(user, "ppo_update")
    policy = _policy(7)
    batch = _make_batch(policy, 12, 7, zero_adv=True)
    batch["returns"] = torch.full((12,), 3.0)
    with torch.no_grad():
        before = float((policy(batch["obs"])[1] - 3.0).abs().mean())
    policy.seen = []
    _run(f, policy, torch.optim.SGD(policy.parameters(), lr=0.1), batch, vf_coef=1.0, ent_coef=0.0, epochs=30, minibatch_size=6)
    with torch.no_grad():
        after = float((policy(batch["obs"])[1] - 3.0).abs().mean())
    assert after < 0.5 * before, (
        f"Chỉ còn value loss (advantage = 0, ent_coef = 0), returns = 3: sai số trung bình của value so với 3 phải giảm mạnh; từ {before:.3f} thành {after:.3f}. "
        f"Mục tiêu của value loss là tensor nào, và dấu của nó trong loss tổng?"
    )
    policy = _policy(7)
    batch = _make_batch(policy, 12, 7, zero_adv=True)
    batch["returns"] = torch.full((12,), 3.0)
    saved = _params(policy)
    _run(f, policy, torch.optim.SGD(policy.parameters(), lr=0.1), batch, vf_coef=0.0, ent_coef=0.0, epochs=2, minibatch_size=6)
    for a, b in zip(saved, _params(policy)):
        assert torch.equal(a, b), "vf_coef = 0 (và advantage = 0, ent_coef = 0): tham số không được đổi. Value loss có được nhân vf_coef không?"


def test_policy_moves_with_advantage(user, ref):
    """Policy đi đúng hướng advantage: sau một bước, log-xác suất tăng ở hành động có A dương, giảm ở hành động có A âm"""
    f = need(user, "ppo_update")
    policy = _policy(8)
    batch = _make_batch(policy, 16, 8, shift=0.0, ret_scale=0.0)
    obs, actions, adv = batch["obs"], batch["actions"], batch["advantages"]

    def logp():
        with torch.no_grad():
            lp = torch.log_softmax(policy(obs)[0], dim=-1).gather(1, actions.unsqueeze(1)).squeeze(1)
        policy.seen = []
        return lp

    before = logp()
    saved = _params(policy)
    _run(f, policy, torch.optim.SGD(policy.parameters(), lr=0.5), batch, vf_coef=0.0, ent_coef=0.0, epochs=1, minibatch_size=16)
    after = logp()
    assert any(not torch.equal(a, b) for a, b in zip(saved, _params(policy))), "Tham số không đổi sau cập nhật: optimizer.step() có được gọi, và loss có gradient không?"
    gain = float((adv * (after - before)).mean())
    assert gain > 0, (
        f"Một bước với tỉ số bằng 1 (old_logp = logp hiện tại): trung bình của A * (thay đổi log-xác suất) phải dương (policy tăng xác suất hành động có A > 0); bạn ra {gain:.5f}. "
        f"Dấu của loss policy, hoặc hướng của optimizer?"
    )


def test_gradient_clipping(user, ref):
    """max_grad_norm cắt chuẩn gradient toàn cục (mặc định 0.5, None thì không cắt), sau backward và trước step"""
    f = need(user, "ppo_update")

    def moved(**kw):
        policy = _policy(9)
        batch = _make_batch(policy, 12, 9, ret_scale=100.0)
        saved = _params(policy)
        _run(f, policy, torch.optim.SGD(policy.parameters(), lr=0.1), batch, vf_coef=1.0, ent_coef=0.0, epochs=1, minibatch_size=12, **kw)
        return float(torch.sqrt(sum(((a - b) ** 2).sum() for a, b in zip(saved, _params(policy)))))

    d_default = moved()
    d_none = moved(max_grad_norm=None)
    d_one = moved(max_grad_norm=1.0)
    assert 0.049 < d_default < 0.0501, (
        f"Gradient rất lớn (returns cỡ 100), lr = 0.1, max_grad_norm mặc định 0.5: tham số phải di chuyển đúng lr * 0.5 = 0.05; bạn di chuyển {d_default:.4f}. "
        f"Bạn cắt gradient chưa, trước hay sau backward, và giá trị mặc định là bao nhiêu?"
    )
    assert 0.0999 < d_one < 0.1001, f"max_grad_norm = 1.0: tham số phải di chuyển 0.1 * 1.0 = 0.1; bạn di chuyển {d_one:.4f}."
    assert d_none > 0.5, f"max_grad_norm = None phải bỏ qua việc cắt (gradient lớn nên bước phải lớn hơn nhiều 0.05); bạn di chuyển {d_none:.4f}."


def test_no_gradient_into_batch(user, ref):
    """advantages, returns và old_logp của người gọi không nhận gradient; batch không bị sửa"""
    f = need(user, "ppo_update")
    policy = _policy(10)
    batch = _make_batch(policy, 12, 10)
    saved = {k: v.clone() for k, v in batch.items()}
    for key in ("advantages", "returns", "old_logp"):
        batch[key] = batch[key].clone().requires_grad_(True)
    _run(f, policy, torch.optim.SGD(policy.parameters(), lr=0.05), batch, epochs=2, minibatch_size=5)
    for key in ("advantages", "returns", "old_logp"):
        g = batch[key].grad
        assert g is None or float(g.abs().max()) == 0.0, f"batch[\"{key}\"] nhận được gradient: nó là dữ liệu cố định, không phải thứ ta tối ưu."
    for key, before in saved.items():
        assert torch.equal(before, batch[key].detach()), f"batch[\"{key}\"] bị sửa tại chỗ."


def test_reuses_ppo_clip_loss(user, ref):
    """Loss policy lấy từ ppo_clip_loss của bạn (bài trước): được gọi đúng một lần cho mỗi minibatch"""
    f = need(user, "ppo_update")
    original = need(user, "ppo_clip_loss")
    calls = []

    def spy(*args, **kwargs):
        calls.append(1)
        return original(*args, **kwargs)

    user["ppo_clip_loss"] = spy
    try:
        policy = _policy(12)
        _run(f, policy, torch.optim.SGD(policy.parameters(), lr=0.01), _make_batch(policy, 10, 12), epochs=2, minibatch_size=4)
    finally:
        user["ppo_clip_loss"] = original
    assert len(calls) == 6, (
        f"ppo_clip_loss phải được gọi 6 lần (2 epoch x 3 minibatch) từ ppo_update; được gọi {len(calls)} lần. "
        f"Bài trước bạn đã viết nó: hãy dùng lại thay vì dựng lại công thức."
    )


def test_returned_stats(user, ref):
    """Số thống kê trả về: kiểu số Python, clip_fraction và approx_kl đúng với tỉ số đã biết ở lần cập nhật đầu"""
    f = need(user, "ppo_update")
    policy = _policy(13)
    n = 8
    batch = _make_batch(policy, n, 13)
    ratios = torch.tensor([1.5, 0.6, 1.0, 1.1, 1.15, 1.3, 1.0, 1.05])
    with torch.no_grad():
        logits, _ = policy(batch["obs"])
        logp = torch.log_softmax(logits, dim=-1).gather(1, batch["actions"].unsqueeze(1)).squeeze(1)
    policy.seen = []
    batch["old_logp"] = logp - torch.log(ratios)
    stats = _run(f, policy, torch.optim.SGD(policy.parameters(), lr=0.01), batch, clip_eps=0.2, epochs=1, minibatch_size=n)
    assert isinstance(stats, dict), f"Cần trả về một dict, bạn trả về {type(stats).__name__}."
    for key in ("loss", "clip_fraction", "approx_kl"):
        assert key in stats, f"Kết quả trả về thiếu khóa \"{key}\" (có: {sorted(stats)})."
        assert isinstance(stats[key], (int, float, np.floating)), f"stats[\"{key}\"] là {type(stats[key]).__name__}: cần một số Python (dùng .item()), không giữ tensor còn gắn đồ thị."
    assert abs(stats["clip_fraction"] - 3 / 8) < 1e-6, (
        f"Một lần cập nhật duy nhất, tỉ số = [1.5, 0.6, 1.0, 1.1, 1.15, 1.3, 1.0, 1.05], eps = 0.2: ba mẫu (1.5, 0.6, 1.3) có |r - 1| > 0.2 nên clip_fraction = 0.375; "
        f"bạn ra {stats['clip_fraction']:.4f}. Thống kê này tính trước hay sau optimizer.step(), và có cắt hai phía không?"
    )
    want_kl = float((-torch.log(ratios)).mean())
    assert abs(stats["approx_kl"] - want_kl) < 1e-5, f"approx_kl = trung bình của (old_logp - new_logp) = {want_kl:.5f}; bạn ra {stats['approx_kl']:.5f}. Dấu của hiệu?"
    assert np.isfinite(stats["loss"]), "stats[\"loss\"] không hữu hạn."
