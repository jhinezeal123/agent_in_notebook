class ResNetCifar(nn.Module):
    def __init__(self, n, shortcut=True, num_classes=10):
        super().__init__()
        block = ResidualBlock if shortcut else PlainBlock
        self.conv1 = nn.Conv2d(3, 16, kernel_size=3, stride=1, padding=1, bias=False)
        self.bn1 = nn.BatchNorm2d(16)
        stages = []
        in_ch = 16
        for i, width in enumerate([16, 32, 64]):
            blocks = []
            for j in range(n):
                stride = 2 if (i > 0 and j == 0) else 1
                blocks.append(block(in_ch, width, stride))
                in_ch = width
            stages.append(nn.Sequential(*blocks))
        self.layer1, self.layer2, self.layer3 = stages
        self.fc = nn.Linear(64, num_classes)

    def forward(self, x):
        out = F.relu(self.bn1(self.conv1(x)))
        out = self.layer3(self.layer2(self.layer1(out)))
        return self.fc(out.mean(dim=(2, 3)))
