class LearnableTemperature(nn.Module):
    def __init__(self, init_tau=0.07):
        super().__init__()
        self.log_scale = nn.Parameter(torch.tensor(float(np.log(1.0 / init_tau))))

    def forward(self, z1, z2):
        scale = self.log_scale.exp().clamp(max=100.0)
        return nt_xent(z1, z2, 1.0 / scale)
