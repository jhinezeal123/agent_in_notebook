def lambda_return(rewards, values, dones, last_value, gamma, lam):
    values = values.detach()
    T = rewards.shape[0]
    out = torch.zeros_like(rewards)
    next_return = last_value
    next_value = last_value
    for t in reversed(range(T)):
        nonterminal = 1.0 - dones[t]
        bootstrap = (1.0 - lam) * next_value + lam * next_return
        next_return = rewards[t] + gamma * nonterminal * bootstrap
        out[t] = next_return
        next_value = values[t]
    return out
