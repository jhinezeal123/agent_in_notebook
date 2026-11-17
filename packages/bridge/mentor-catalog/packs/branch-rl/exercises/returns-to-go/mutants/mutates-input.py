def returns_to_go(rewards, gamma, dones=None):
    if not isinstance(rewards, np.ndarray):
        rewards = np.asarray(rewards, dtype=np.float64)
    n = len(rewards)
    if dones is None:
        dones = np.zeros(n)
    for t in range(n - 2, -1, -1):
        rewards[t] += gamma * (1.0 - dones[t]) * rewards[t + 1]
    return rewards
