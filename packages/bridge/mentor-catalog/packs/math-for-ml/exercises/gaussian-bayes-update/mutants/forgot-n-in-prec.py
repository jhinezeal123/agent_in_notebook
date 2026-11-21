def posterior_normal(x, mu0, var0, obs_var):
    x = np.asarray(x, dtype=float).ravel()
    var_post = 1.0 / (1.0 / var0 + 1.0 / obs_var)
    mu_post = var_post * (mu0 / var0 + (float(x.mean()) if x.size else 0.0) / obs_var)
    return float(mu_post), float(var_post)

def predictive_normal(x, mu0, var0, obs_var):
    m, v = posterior_normal(x, mu0, var0, obs_var)
    return m, float(v + obs_var)
