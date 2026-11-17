def compute_gae(rewards, values, dones, last_value, gamma, lam):
    values = values.detach()
    T = rewards.shape[0]
    advantages = torch.zeros_like(rewards)
    last_adv = 0.0
    next_value = last_value
    for t in reversed(range(T)):
        next_value = values[t]
        nonterminal = 1.0 - dones[t]
        delta = rewards[t] + gamma * next_value * nonterminal - values[t]
        last_adv = delta + gamma * lam * nonterminal * last_adv
        advantages[t] = last_adv
    returns = advantages + values
    return advantages, returns
