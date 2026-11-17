class VAE(nn.Module):
    def __init__(self, in_dim=16, hidden=32, latent=4):
        super().__init__()
        self.enc = nn.Sequential(nn.Linear(in_dim, hidden), nn.ReLU())
        self.fc_mu = nn.Linear(hidden, latent)
        self.fc_logvar = nn.Linear(hidden, latent)
        self.dec = nn.Sequential(nn.Linear(latent, hidden), nn.ReLU(), nn.Linear(hidden, in_dim))

    def forward(self, x, eps=None):
        h = self.enc(x)
        mu, logvar = self.fc_mu(h), self.fc_logvar(h)
        z = reparameterize(mu, logvar)
        return self.dec(z), mu, logvar


def elbo_loss(x, x_logits, mu, logvar, beta=1.0):
    recon = F.binary_cross_entropy_with_logits(x_logits, x, reduction="sum") / x.size(0)
    return recon + beta * kl_gaussian(mu, logvar).mean()
