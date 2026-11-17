def select_action(q, eps, rng):
    if rng.random() < eps:
        return int(rng.integers(len(q)))
    best = np.flatnonzero(q == q.max())
    return int(rng.choice(best))


def update(q, n, a, r):
    q[a] += (r - q[a]) / max(n[a], 1)
    n[a] += 1


def run_bandit(rewards, eps, rng):
    steps, k = rewards.shape
    q = np.zeros(k)
    n = np.zeros(k, dtype=np.int64)
    actions = np.zeros(steps, dtype=np.int64)
    for t in range(steps):
        a = select_action(q, eps, rng)
        update(q, n, a, rewards[t, a])
        actions[t] = a
    return q, n, actions
