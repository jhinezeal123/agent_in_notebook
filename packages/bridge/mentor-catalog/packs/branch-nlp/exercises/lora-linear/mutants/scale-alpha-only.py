class LoRALinear(nn.Module):
    def __init__(self, base, r=4, alpha=8.0):
        super().__init__()
        self.base = base
        for p in self.base.parameters():
            p.requires_grad_(False)
        self.A = nn.Parameter(torch.randn(r, base.in_features) / base.in_features ** 0.5)
        self.B = nn.Parameter(torch.zeros(base.out_features, r))
        self.scale = alpha

    def forward(self, x):
        return self.base(x) + self.scale * (x @ self.A.T) @ self.B.T
