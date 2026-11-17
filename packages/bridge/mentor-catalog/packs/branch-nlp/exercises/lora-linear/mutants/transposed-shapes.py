class LoRALinear(nn.Module):
    def __init__(self, base, r=4, alpha=8.0):
        super().__init__()
        self.base = base
        for p in self.base.parameters():
            p.requires_grad_(False)
        self.A = nn.Parameter(torch.randn(base.in_features, r) / base.in_features ** 0.5)
        self.B = nn.Parameter(torch.zeros(r, base.out_features))
        self.scale = alpha / r

    def forward(self, x):
        return self.base(x) + self.scale * (x @ self.A) @ self.B
