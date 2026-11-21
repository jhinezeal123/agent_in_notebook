def mystery_block_b(Z, tau):
    S = Z / tau
    m = S.max(axis=-1, keepdims=True)
    lse = m + np.log(np.exp(S - m).sum(axis=-1, keepdims=True))
    log_p = S - lse
    P = np.exp(log_p)
    H = -(P * log_p).sum(axis=-1)
    return m, lse, P, H
