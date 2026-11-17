class BatchNorm2d(nn.Module):
    def __init__(self, num_features, eps=1e-5, momentum=0.1):
        super().__init__()
        self.eps = eps
        self.momentum = momentum
        self.weight = nn.Parameter(torch.ones(num_features))
        self.bias = nn.Parameter(torch.zeros(num_features))
        self.register_buffer("running_mean", torch.zeros(num_features))
        self.register_buffer("running_var", torch.ones(num_features))
        self.register_buffer("num_batches_tracked", torch.tensor(0, dtype=torch.long))

    def forward(self, x):
        if self.training:
            n = x.numel() // x.size(1)
            if n <= 1:
                raise ValueError("Cần hơn một giá trị cho mỗi kênh khi train")
            mean = x.mean(dim=(0, 2, 3), keepdim=True)
            var = ((x - mean) ** 2).mean(dim=(0, 2, 3), keepdim=True)
            with torch.no_grad():
                m = self.momentum
                self.running_mean.mul_(1 - m).add_(mean.view(-1), alpha=m)
                self.running_var.mul_(1 - m).add_(var.view(-1) * n / (n - 1), alpha=m)
        else:
            mean = self.running_mean.view(1, -1, 1, 1)
            var = self.running_var.view(1, -1, 1, 1)
        x_hat = (x - mean) / torch.sqrt(var + self.eps)
        return x_hat * self.weight.view(1, -1, 1, 1) + self.bias.view(1, -1, 1, 1)
