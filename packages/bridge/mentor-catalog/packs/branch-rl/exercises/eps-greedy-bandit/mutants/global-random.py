def select_action(q, eps, rng):
    if np.random.random() < eps:
        return int(np.random.randint(len(q)))
    best = np.flatnonzero(q == q.max())
    return int(np.random.choice(best))


def update(q, n, a, r):
    n[a] += 1
    q[a] += (r - q[a]) / n[a]


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
