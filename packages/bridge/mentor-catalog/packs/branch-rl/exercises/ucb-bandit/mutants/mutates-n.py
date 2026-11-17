def select_ucb(q, n, t, c):
    n[n == 0] = 1
    score = q + c * np.sqrt(np.log(t) / n)
    return int(np.argmax(score))
