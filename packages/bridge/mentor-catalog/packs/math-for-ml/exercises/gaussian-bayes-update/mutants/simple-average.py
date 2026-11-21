def posterior_normal(x, mu0, var0, obs_var):
    x = np.asarray(x, dtype=float).ravel()
    if x.size == 0:
        return float(mu0), float(var0)
    return float(0.5 * (mu0 + x.mean())), float(0.5 * (var0 + obs_var))

def predictive_normal(x, mu0, var0, obs_var):
    m, v = posterior_normal(x, mu0, var0, obs_var)
    return m, float(v + obs_var)
