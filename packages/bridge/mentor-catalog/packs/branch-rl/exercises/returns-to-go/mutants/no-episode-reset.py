def returns_to_go(rewards, gamma, dones=None):
    rewards = np.asarray(rewards, dtype=np.float64)
    n = len(rewards)
    out = np.zeros(n)
    running = 0.0
    for t in range(n - 1, -1, -1):
        running = rewards[t] + gamma * running
        out[t] = running
    return out
