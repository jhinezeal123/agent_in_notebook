class LearnableTemperature(nn.Module):
    def __init__(self, init_tau=0.07):
        super().__init__()
        self.log_scale = nn.Parameter(torch.tensor(float(np.log(1.0 / init_tau))))

    def forward(self, z1, z2):
        scale = self.log_scale.exp().clamp(max=100.0)
        z = F.normalize(torch.cat([z1, z2], dim=0), dim=1)
        n = z1.shape[0]
        logits = (z @ z.T / (1.0 / scale)).masked_fill(torch.eye(2 * n, dtype=torch.bool), float("-inf"))
        return F.cross_entropy(logits, (torch.arange(2 * n) + n) % (2 * n))
