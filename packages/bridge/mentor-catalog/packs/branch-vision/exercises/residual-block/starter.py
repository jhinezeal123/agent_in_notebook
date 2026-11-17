class ResidualBlock(nn.Module):
    """Khối residual cơ bản của ResNet.
    Thuộc tính: conv1 (3x3, stride), bn1, conv2 (3x3), bn2, shortcut (Identity khi in_ch == out_ch và stride == 1, ngược lại Sequential(Conv 1x1, BatchNorm)).
    forward: x (B, in_ch, H, W) -> (B, out_ch, ceil(H / stride), ceil(W / stride))."""

    def __init__(self, in_ch, out_ch, stride=1):
        raise NotImplementedError

    def forward(self, x):
        raise NotImplementedError
