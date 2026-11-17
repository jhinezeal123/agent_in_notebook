class BatchNorm2d(nn.Module):
    """Batch Normalization 2D tự viết.
    Tham số: weight (C,) = 1, bias (C,) = 0. Buffer: running_mean (C,) = 0, running_var (C,) = 1, num_batches_tracked (0 chiều, long) = 0.
    Số Python: eps, momentum. forward: x (N, C, H, W) -> (N, C, H, W); train dùng thống kê của batch và cập nhật buffer, eval dùng buffer."""

    def __init__(self, num_features, eps=1e-5, momentum=0.1):
        raise NotImplementedError

    def forward(self, x):
        raise NotImplementedError
