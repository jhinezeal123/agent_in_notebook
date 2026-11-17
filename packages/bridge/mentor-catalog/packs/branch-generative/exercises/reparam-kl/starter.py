def reparameterize(mu, logvar, eps=None):
    """mu, logvar: (..., D), logvar = log phương sai. eps: None hoặc tensor (..., D).
    Trả z = mu + sigma * eps, cùng shape với mu; gradient phải chảy về mu và logvar."""
    raise NotImplementedError


def kl_gaussian(mu, logvar):
    """KL( N(mu, sigma^2) || N(0, I) ), cộng theo chiều latent (trục cuối).
    mu, logvar: (..., D) -> (...,)."""
    raise NotImplementedError
