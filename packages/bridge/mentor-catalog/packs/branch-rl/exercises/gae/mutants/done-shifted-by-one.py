def compute_gae(rewards, values, dones, last_value, gamma, lam):
    values = values.detach()
    T = rewards.shape[0]
    advantages = torch.zeros_like(rewards)
    last_adv = 0.0
    next_value = last_value
    for t in reversed(range(T)):
        nonterminal = 1.0 - (dones[t + 1] if t + 1 < T else 0.0)
        delta = rewards[t] + gamma * next_value * nonterminal - values[t]
        last_adv = delta + gamma * lam * nonterminal * last_adv
        advantages[t] = last_adv
        next_value = values[t]
    returns = advantages + values
    return advantages, returns
