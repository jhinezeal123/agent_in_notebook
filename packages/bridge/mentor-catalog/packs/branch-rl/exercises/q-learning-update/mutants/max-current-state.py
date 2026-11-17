def q_update(Q, s, a, r, s_next, done, alpha, gamma):
    target = r if done else r + gamma * Q[s].max()
    td_error = target - Q[s, a]
    Q[s, a] += alpha * td_error
    return float(td_error)


def q_learning(env, episodes, alpha, gamma, eps, rng):
    Q = np.zeros((env.n_states, env.n_actions))
    for _ in range(episodes):
        s = env.reset()
        done = False
        while not done:
            if rng.random() < eps:
                a = int(rng.integers(env.n_actions))
            else:
                a = int(rng.choice(np.flatnonzero(Q[s] == Q[s].max())))
            s_next, r, done = env.step(a)
            q_update(Q, s, a, r, s_next, done, alpha, gamma)
            s = s_next
    return Q
