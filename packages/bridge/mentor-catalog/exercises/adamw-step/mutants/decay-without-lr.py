def adamw_init(params):
    return {"t": 0, "m": {k: np.zeros_like(v, dtype=float) for k, v in params.items()}, "v": {k: np.zeros_like(v, dtype=float) for k, v in params.items()}}


def adamw_step(params, grads, state, lr=1e-3, b1=0.9, b2=0.999, eps=1e-8, wd=1e-2):
    t = state["t"] + 1
    m, v, out = {}, {}, {}
    for k, p in params.items():
        g = np.asarray(grads[k], dtype=float)
        m[k] = b1 * state["m"][k] + (1 - b1) * g
        v[k] = b2 * state["v"][k] + (1 - b2) * g * g
        step = (m[k] / (1 - b1 ** t)) / (np.sqrt(v[k] / (1 - b2 ** t)) + eps)
        out[k] = p - wd * p - lr * step
    return out, {"t": t, "m": m, "v": v}
