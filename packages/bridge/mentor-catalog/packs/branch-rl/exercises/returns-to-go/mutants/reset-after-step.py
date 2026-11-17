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
        running = rewards[t] + gamma * running
        out[t] = running
        if dones[t]:
            running = 0.0
    return out
