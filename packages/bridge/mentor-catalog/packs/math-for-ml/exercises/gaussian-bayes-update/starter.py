def posterior_normal(x, mu0, var0, obs_var):
    """Trả về (mu_post, var_post) của hậu nghiệm theta | x."""
    raise NotImplementedError


def predictive_normal(x, mu0, var0, obs_var):
    """Trả về (mu_pred, var_pred) cho quan sát mới x_new | x."""
    raise NotImplementedError
