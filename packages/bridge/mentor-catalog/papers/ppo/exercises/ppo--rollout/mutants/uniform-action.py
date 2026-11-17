def collect_rollout(env, obs, policy, steps, gamma, lam, generator):
    obs_list, act_list, logp_list, val_list, rew_list, done_list = [], [], [], [], [], []
    episode_returns = []
    episode_return = 0.0
    for _ in range(steps):
        obs_t = torch.as_tensor(obs, dtype=torch.float32)
        with torch.no_grad():
            logits, value = policy(obs_t.unsqueeze(0))
            log_probs = F.log_softmax(logits[0], dim=-1)
            action = int(torch.randint(0, 2, (1,), generator=generator))
        next_obs, reward, done, truncated = env.step(action)
        obs_list.append(obs_t)
        act_list.append(action)
        logp_list.append(log_probs[action])
        val_list.append(value[0])
        rew_list.append(reward)
        done_list.append(float(done or truncated))
        episode_return += reward
        if done or truncated:
            episode_returns.append(episode_return)
            episode_return = 0.0
            obs = env.reset()
        else:
            obs = next_obs
    with torch.no_grad():
        last_value = policy(torch.as_tensor(obs, dtype=torch.float32).unsqueeze(0))[1][0]
    rewards = torch.tensor(rew_list, dtype=torch.float32)
    values = torch.stack(val_list)
    dones = torch.tensor(done_list, dtype=torch.float32)
    advantages, returns = compute_gae(rewards, values, dones, last_value, gamma, lam)
    batch = {
        "obs": torch.stack(obs_list),
        "actions": torch.tensor(act_list, dtype=torch.int64),
        "old_logp": torch.stack(logp_list),
        "advantages": advantages,
        "returns": returns,
    }
    return batch, obs, episode_returns
