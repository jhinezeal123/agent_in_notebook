def posterior_normal(x, mu0, var0, obs_var):
    x = np.asarray(x, dtype=float).ravel()
    var_post = 1.0 / (1.0 / var0 + x.size / obs_var)
    mu_post = var_post * (mu0 / var0 + float(x.sum()) / obs_var)
    return float(mu_post), float(var_post)

def predictive_normal(x, mu0, var0, obs_var):
    return posterior_normal(x, mu0, var0, obs_var)
