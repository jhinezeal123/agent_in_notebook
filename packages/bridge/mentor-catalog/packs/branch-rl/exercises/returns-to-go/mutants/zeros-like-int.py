def returns_to_go(rewards, gamma, dones=None):
    rewards = np.asarray(rewards)
    n = len(rewards)
    if dones is None:
        dones = np.zeros(n)
    else:
        dones = np.asarray(dones, dtype=np.float64)
    out = np.zeros_like(rewards)
    running = 0.0
    for t in range(n - 1, -1, -1):
        running = rewards[t] + gamma * (1.0 - dones[t]) * running
        out[t] = running
    return out
