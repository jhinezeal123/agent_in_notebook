class LearnableTemperature(nn.Module):
    """NT-Xent với temperature học được (kiểu CLIP). Thuộc tính: log_scale (nn.Parameter 0 chiều, khởi tạo ln(1 / init_tau)).
    forward(z1, z2): z1, z2 (N, D) -> loss (một số), dùng lại nt_xent của bạn với temperature = 1 / min(exp(log_scale), 100)."""

    def __init__(self, init_tau=0.07):
        raise NotImplementedError

    def forward(self, z1, z2):
        raise NotImplementedError
