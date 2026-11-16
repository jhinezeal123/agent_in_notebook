def adamw_init(params):
    return {"t": 0, "m": {k: np.zeros_like(v, dtype=float) for k, v in params.items()}, "v": {k: np.zeros_like(v, dtype=float) for k, v in params.items()}}


def adamw_step(params, grads, state, lr=1e-3, b1=0.9, b2=0.999, eps=1e-8, wd=1e-2):
    t = state["t"] + 1
    m, v, out = {}, {}, {}
    for k, p in params.items():
        p = np.asarray(p, dtype=float)
        g = np.asarray(grads[k], dtype=float)
        m[k] = b1 * state["m"][k] + (1 - b1) * g
        v[k] = b2 * state["v"][k] + (1 - b2) * g * g
        m_hat = m[k] / (1 - b1 ** t)
        v_hat = v[k] / (1 - b2 ** t)
        out[k] = p - lr * (m_hat / (np.sqrt(v_hat) + eps) + wd * p)
    return out, {"t": t, "m": m, "v": v}
