def reparameterize(mu, logvar, eps=None):
    if eps is None:
        eps = torch.randn_like(mu)
    return mu + torch.exp(0.5 * logvar) * eps


def kl_gaussian(mu, logvar):
    return -0.5 * (1 + logvar - mu.pow(2) - logvar.exp()).sum(dim=-1)
