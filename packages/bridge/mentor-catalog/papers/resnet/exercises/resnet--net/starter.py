class ResNetCifar(nn.Module):
    """ResNet kiểu CIFAR (paper §4.2) có 6n + 2 lớp.
    Thuộc tính: conv1 (3 -> 16, 3x3) + bn1, layer1/layer2/layer3 (mỗi cái nn.Sequential gồm n khối, 16/32/64 kênh, stage 2 và 3 giảm độ phân giải ở khối đầu), fc.
    shortcut=True dùng ResidualBlock của bạn, shortcut=False dùng PlainBlock (cho sẵn). forward: x (B, 3, H, W) -> logits (B, num_classes)."""

    def __init__(self, n, shortcut=True, num_classes=10):
        super().__init__()
        raise NotImplementedError

    def forward(self, x):
        raise NotImplementedError
