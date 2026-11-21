def posterior_normal(x, mu0, var0, obs_var):
    x = np.asarray(x, dtype=float).ravel()
    n = x.size
    prec0 = 1.0 / float(var0)
    prec_obs = n / float(obs_var)
    var_post = 1.0 / (prec0 + prec_obs)
    mu_post = var_post * (float(mu0) * prec0 + float(x.sum()) / float(obs_var))
    return float(mu_post), float(var_post)


def predictive_normal(x, mu0, var0, obs_var):
    mu_post, var_post = posterior_normal(x, mu0, var0, obs_var)
    return float(mu_post), float(var_post + float(obs_var))
