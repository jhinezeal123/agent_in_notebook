GAMMA, LAM = 0.99, 0.95
SEED_ENV = 123


class _Fixed(nn.Module):
    """Policy giả: logits = [0, logit1] ở mọi trạng thái, value = value ở mọi trạng thái (một tham số dummy để có đồ thị gradient nếu quên tắt)."""

    def __init__(self, logit1=0.0, value=0.0):
        super().__init__()
        self.dummy = nn.Parameter(torch.zeros(1))
        self.logit1 = float(logit1)
        self.value = float(value)

    def forward(self, obs):
        n = obs.shape[0]
        logits = torch.stack([torch.zeros(n), torch.full((n,), self.logit1)], dim=1) + self.dummy
        return logits, torch.full((n,), self.value) + self.dummy


def _policy(ref, seed=1):
    t.seed(seed)
    return ref["ActorCritic"]()


def _start(ref, seed=SEED_ENV):
    env = ref["CartPole"]()
    return env, env.reset(seed=seed)


def _collect(user, ref, policy, steps, gamma=GAMMA, lam=LAM, gen_seed=0):
    env, obs = _start(ref)
    return need(user, "collect_rollout")(env, obs, policy, steps, gamma, lam, torch.Generator().manual_seed(gen_seed))


def _replay(ref, actions, seed=SEED_ENV):
    """Chạy lại các hành động trên một môi trường mới cùng seed (reset() không seed sau mỗi episode): trả về obs từng bước, reward, done (done hoặc truncated), obs cuối."""
    env = ref["CartPole"]()
    obs = env.reset(seed=seed)
    seq, rewards, dones = [], [], []
    for a in actions.tolist():
        seq.append(obs)
        obs, reward, done, truncated = env.step(int(a))
        rewards.append(reward)
        dones.append(float(done or truncated))
        if done or truncated:
            obs = env.reset()
    return np.array(seq), torch.tensor(rewards, dtype=torch.float32), torch.tensor(dones, dtype=torch.float32), obs


def test_batch_shapes_and_dtypes(user, ref):
    """Trả về (batch, obs, episode_returns); batch có obs (T, 4) float32, actions (T,) int64 trong {0, 1}, old_logp, advantages, returns (T,) float32"""
    T = 40
    out = _collect(user, ref, _policy(ref), T)
    assert isinstance(out, tuple) and len(out) == 3, "collect_rollout phải trả về một bộ ba (batch, obs, episode_returns)."
    batch, obs, episode_returns = out
    assert isinstance(batch, dict), "Phần tử đầu của bộ ba phải là một dict (batch)."
    for key in ["obs", "actions", "old_logp", "advantages", "returns"]:
        assert key in batch, f"batch thiếu khóa \"{key}\" (ppo_update cần đủ obs, actions, old_logp, advantages, returns)."
    t.shape(batch["obs"], (T, 4), what="batch[\"obs\"]")
    for key in ["actions", "old_logp", "advantages", "returns"]:
        t.shape(batch[key], (T,), what=f"batch[\"{key}\"]")
    assert batch["obs"].dtype == torch.float32, f"batch[\"obs\"] có dtype {batch['obs'].dtype}, cần float32."
    assert batch["actions"].dtype == torch.int64, f"batch[\"actions\"] có dtype {batch['actions'].dtype}, cần int64 (dùng làm chỉ số trong gather)."
    for key in ["old_logp", "advantages", "returns"]:
        assert batch[key].dtype == torch.float32, f"batch[\"{key}\"] có dtype {batch[key].dtype}, cần float32."
    assert bool(((batch["actions"] == 0) | (batch["actions"] == 1)).all()), "batch[\"actions\"] có giá trị ngoài {0, 1}."
    assert tuple(np.shape(obs)) == (4,), f"obs trả về có shape {tuple(np.shape(obs))}, cần (4,): trạng thái hiện tại của môi trường, để lần gọi sau chạy tiếp."
    assert isinstance(episode_returns, list), "episode_returns phải là một list."


def test_trajectory_matches_environment(user, ref):
    """Các obs, actions đã lưu khớp một lần chạy lại thật trên môi trường: lưu đúng trạng thái trước mỗi bước, và reset() đúng chỗ sau khi episode kết thúc"""
    T = 150
    batch, _, _ = _collect(user, ref, _policy(ref), T)
    seq, _, dones, _ = _replay(ref, batch["actions"])
    assert int(dones.sum()) >= 2, "Môi trường kiểm tra phải có ít nhất hai episode kết thúc (lỗi của máy chấm)."
    bad = [i for i in range(T) if not np.allclose(batch["obs"][i].detach().numpy(), seq[i], atol=1e-6)]
    assert not bad, f"batch[\"obs\"][{bad[0]}] không khớp trạng thái thật ở bước {bad[0]}: mỗi hàng phải là trạng thái TRƯỚC khi chọn hành động ở bước đó, và sau khi episode kết thúc phải reset() môi trường rồi tiếp tục từ trạng thái mới."


def test_resets_after_episode_end(user, ref):
    """Sau khi một episode kết thúc (gậy đổ), trạng thái kế tiếp là trạng thái đầu mới của môi trường (mọi thành phần nhỏ hơn 0,05), không phải trạng thái vượt giới hạn"""
    T = 60
    batch, _, _ = _collect(user, ref, _Fixed(logit1=40.0), T)
    _, _, dones, _ = _replay(ref, batch["actions"])
    ends = [i for i in range(T - 1) if dones[i] == 1.0]
    assert len(ends) >= 3, "Môi trường kiểm tra phải có ít nhất ba episode kết thúc (lỗi của máy chấm)."
    for i in ends:
        first = batch["obs"][i + 1].abs().max().item()
        assert first <= 0.05 + 1e-6, f"Sau khi episode kết thúc ở bước {i}, trạng thái kế tiếp có thành phần {first:.2f}: đó không phải trạng thái đầu của episode mới (mọi thành phần trong [−0,05; 0,05]). Bạn đã reset môi trường chưa?"


def test_episode_returns_reported(user, ref):
    """episode_returns liệt kê, theo thứ tự, tổng reward của từng episode đã kết thúc trong rollout (episode đang dở không tính)"""
    T = 60
    batch, _, episode_returns = _collect(user, ref, _Fixed(logit1=40.0), T)
    _, rewards, dones, _ = _replay(ref, batch["actions"])
    want, total = [], 0.0
    for r, d in zip(rewards.tolist(), dones.tolist()):
        total += r
        if d == 1.0:
            want.append(total)
            total = 0.0
    got = [float(x) for x in episode_returns]
    assert len(got) == len(want), f"episode_returns có {len(got)} phần tử, cần {len(want)} (mỗi episode kết thúc trong rollout một phần tử)."
    assert np.allclose(got, want), f"episode_returns = {got[:5]}…, cần {want[:5]}…: mỗi phần tử là tổng reward của một episode, tính từ lúc nó bắt đầu (trong rollout này) tới lúc kết thúc."


def test_old_logp_matches_policy(user, ref):
    """old_logp là log xác suất mà policy gán cho đúng hành động đã chọn tại đúng trạng thái đã lưu (≤ 0, khớp tính lại bằng policy)"""
    policy = _policy(ref)
    batch, _, _ = _collect(user, ref, policy, 40)
    with torch.no_grad():
        logits, _ = policy(batch["obs"])
        want = F.log_softmax(logits, dim=-1).gather(1, batch["actions"].unsqueeze(1)).squeeze(1)
    t.close(batch["old_logp"], want, tol=1e-5, what="batch[\"old_logp\"] (log xác suất của hành động đã chọn, tính lúc thu thập)")


def test_advantages_come_from_gae(user, ref):
    """advantages và returns bằng compute_gae trên reward, value, done của chính rollout đó, với đúng gamma, lam được truyền vào (qua nhiều episode)"""
    policy = _policy(ref)
    gamma, lam = 0.97, 0.9
    batch, obs_last, _ = _collect(user, ref, policy, 100, gamma=gamma, lam=lam)
    _, rewards, dones, _ = _replay(ref, batch["actions"])
    with torch.no_grad():
        values = policy(batch["obs"])[1]
        last_value = policy(torch.as_tensor(obs_last, dtype=torch.float32).unsqueeze(0))[1][0]
        adv, ret = ref["compute_gae"](rewards, values, dones, last_value, gamma, lam)
    t.close(batch["advantages"], adv, tol=1e-4, what="batch[\"advantages\"]")
    t.close(batch["returns"], ret, tol=1e-4, what="batch[\"returns\"]")


def test_last_value_bootstraps_cut_episode(user, ref):
    """Rollout cắt giữa episode: bước cuối dùng V của trạng thái kế tiếp (last_value) để bootstrap, không coi như tương lai bằng 0"""
    c, T = 3.0, 4
    batch, _, _ = _collect(user, ref, _Fixed(logit1=0.0, value=c), T)
    _, _, dones, _ = _replay(ref, batch["actions"])
    assert float(dones.sum()) == 0.0, "Rollout ngắn kiểm tra không được có episode kết thúc (lỗi của máy chấm)."
    delta = 1.0 + GAMMA * c - c
    adv, last = np.zeros(T), 0.0
    for i in reversed(range(T)):
        last = delta + GAMMA * LAM * last
        adv[i] = last
    t.close(batch["advantages"], adv, tol=1e-5, what="batch[\"advantages\"] khi V ≡ 3 và không có episode nào kết thúc")
    t.close(batch["returns"], adv + c, tol=1e-5, what="batch[\"returns\"] khi V ≡ 3 và không có episode nào kết thúc")


def test_continues_from_given_obs(user, ref):
    """Gọi lần hai với obs được trả về ở lần một thì chạy tiếp đúng episode đang dở (không reset ở đầu hàm)"""
    policy = _policy(ref)
    collect = need(user, "collect_rollout")
    env, obs = _start(ref)
    gen = torch.Generator().manual_seed(0)
    batch1, obs1, _ = collect(env, obs, policy, 10, GAMMA, LAM, gen)
    batch2, _, _ = collect(env, obs1, policy, 10, GAMMA, LAM, gen)
    first = batch2["obs"][0].detach().numpy()
    assert np.allclose(first, obs1, atol=1e-6), "Hàng đầu của batch lần hai không phải obs mà lần một trả về: collect_rollout phải bắt đầu từ đúng `obs` được đưa vào (episode đang chạy dở), không reset môi trường ở đầu hàm."
    seq, _, _, _ = _replay(ref, torch.cat([batch1["actions"], batch2["actions"]]))
    assert np.allclose(torch.cat([batch1["obs"], batch2["obs"]]).detach().numpy(), seq, atol=1e-6), "Hai lần gọi liên tiếp không ghép thành một quỹ đạo liền mạch trên môi trường."


def test_sampling_follows_policy(user, ref):
    """Hành động được lấy mẫu từ phân phối softmax của logits (không tham lam, không đều): policy 25% / 75% cho khoảng 75% hành động 1"""
    batch, _, _ = _collect(user, ref, _Fixed(logit1=float(np.log(3.0))), 2000)
    freq = float((batch["actions"] == 1).float().mean())
    assert abs(freq - 0.75) < 0.04, f"Với policy cho hành động 1 xác suất 0,75, bạn chọn hành động 1 trong {freq:.2f} số bước, cần khoảng 0,75: hành động phải được lấy mẫu từ xác suất của policy."


def test_uses_given_generator(user, ref):
    """Lấy mẫu hành động bằng generator được truyền vào: cùng seed cho đúng cùng hành động dù seed toàn cục của torch khác nhau; khác seed cho hành động khác"""
    policy = _policy(ref)
    runs = []
    for outside, gen_seed in [(11, 5), (22, 5), (11, 6)]:
        torch.manual_seed(outside)
        batch, _, _ = _collect(user, ref, policy, 100, gen_seed=gen_seed)
        runs.append(batch["actions"])
    assert torch.equal(runs[0], runs[1]), "Hai lần chạy với generator cùng seed cho chuỗi hành động khác nhau: bạn đang lấy mẫu bằng bộ sinh số ngẫu nhiên toàn cục thay vì `generator` được truyền vào."
    assert not torch.equal(runs[0], runs[2]), "Hai generator khác seed cho đúng cùng chuỗi hành động: `generator` chưa được dùng để lấy mẫu."


def test_no_gradient_graph(user, ref):
    """Dữ liệu thu thập không dính đồ thị gradient (thu thập dưới no_grad hoặc detach), và policy không nhận gradient"""
    policy = _policy(ref)
    batch, _, _ = _collect(user, ref, policy, 30)
    for key, value in batch.items():
        assert not value.requires_grad, f"batch[\"{key}\"] đang dính đồ thị gradient (requires_grad = True): tính log xác suất và value lúc thu thập phải nằm ngoài đồ thị, vì chúng là số cố định so sánh với policy mới."
    assert all(p.grad is None for p in policy.parameters()), "policy đã nhận gradient trong lúc thu thập: việc này không được tính gradient."
