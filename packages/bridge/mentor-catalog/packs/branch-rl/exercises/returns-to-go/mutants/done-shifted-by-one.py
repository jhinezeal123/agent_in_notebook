def returns_to_go(rewards, gamma, dones=None):
    rewards = np.asarray(rewards, dtype=np.float64)
    n = len(rewards)
    if dones is None:
        dones = np.zeros(n)
    else:
        dones = np.asarray(dones, dtype=np.float64)
    out = np.zeros(n)
    running = 0.0
    for t in range(n - 1, -1, -1):
        starts_new = dones[t + 1] if t + 1 < n else 0.0
        running = rewards[t] + gamma * (1.0 - starts_new) * running
        out[t] = running
    return out
