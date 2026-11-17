import math

# DDPM thu nhỏ: ảnh chữ số 1 kênh, 32 x 32 (MNIST 28 x 28 thêm viền nền 2 pixel mỗi phía), giá trị trong [-1, 1], -1 là nền đen.
IMG_SIZE = 32


def load_mnist(n, train=True):
    """n ảnh đầu tiên của tập train (hoặc tập test khi train=False) của MNIST: tensor float32 shape (n, 1, 32, 32), giá trị trong [-1, 1].
    Cần Internet ở lần chạy đầu (torchvision tải MNIST về thư mục mnist_data). Không có Internet thì dùng tạm bộ chữ số 8x8 của scikit-learn
    (1500 ảnh train, 297 ảnh test, phóng to lên 28 x 28: nhòe hơn MNIST thật) và in một dòng cảnh báo."""
    try:
        from torchvision import datasets
        raw = datasets.MNIST("mnist_data", train=train, download=True).data[:n].float() / 255.0
    except Exception as e:
        from sklearn.datasets import load_digits
        print(f"Không tải được MNIST ({type(e).__name__}): dùng tạm bộ chữ số 8x8 của scikit-learn, nhòe hơn và ít ảnh hơn.")
        digits = torch.tensor(load_digits().images, dtype=torch.float32) / 16.0
        digits = digits[:1500] if train else digits[1500:]
        raw = F.interpolate(digits[:n].unsqueeze(1), size=(28, 28), mode="bilinear", align_corners=False).squeeze(1)
    x = raw * 2.0 - 1.0
    return F.pad(x, (2, 2, 2, 2), value=-1.0).unsqueeze(1)


def show_images(x, ncols=8, title=""):
    """Vẽ một lưới ảnh chữ số. x: tensor (N, 1, H, W) giá trị quanh [-1, 1] (giá trị ngoài khoảng bị cắt khi vẽ, dữ liệu không bị đổi)."""
    import matplotlib.pyplot as plt
    x = x.detach().cpu().float()
    nrows = (len(x) + ncols - 1) // ncols
    fig, axes = plt.subplots(nrows, ncols, figsize=(ncols * 1.2, nrows * 1.2), squeeze=False)
    for i, ax in enumerate(axes.flat):
        ax.axis("off")
        if i < len(x):
            ax.imshow(((x[i, 0] + 1) / 2).clamp(0, 1), cmap="gray", vmin=0, vmax=1)
    fig.suptitle(title)
    plt.tight_layout()
    plt.show()


def _time_embedding(t, dim):
    """Mã hóa bước t (int64, shape (B,)) thành vector sin/cos shape (B, dim)."""
    half = dim // 2
    freqs = torch.exp(-math.log(10000.0) * torch.arange(half, device=t.device, dtype=torch.float32) / half)
    args = t.float()[:, None] * freqs[None, :]
    return torch.cat([args.sin(), args.cos()], dim=1)


class _ResBlock(nn.Module):
    def __init__(self, cin, cout, tdim):
        super().__init__()
        self.norm1 = nn.GroupNorm(8, cin)
        self.conv1 = nn.Conv2d(cin, cout, 3, padding=1)
        self.temb = nn.Linear(tdim, cout)
        self.norm2 = nn.GroupNorm(8, cout)
        self.conv2 = nn.Conv2d(cout, cout, 3, padding=1)
        self.skip = nn.Conv2d(cin, cout, 1) if cin != cout else nn.Identity()

    def forward(self, x, emb):
        h = self.conv1(F.silu(self.norm1(x)))
        h = h + self.temb(F.silu(emb))[:, :, None, None]
        h = self.conv2(F.silu(self.norm2(h)))
        return h + self.skip(x)


class TinyUNet(nn.Module):
    """U-Net nhỏ (khoảng 0,7 triệu tham số) cho ảnh (B, 1, 32, 32): model(x_t, t) -> dự đoán nhiễu, cùng shape với x_t.
    x_t: float32 (B, 1, 32, 32); t: int64 (B,), giá trị là chỉ số bước từ 0 (mã hóa bằng sin/cos rồi cộng vào mọi khối)."""

    def __init__(self, base=32):
        super().__init__()
        self.base = base
        tdim = 4 * base
        self.time_mlp = nn.Sequential(nn.Linear(base, tdim), nn.SiLU(), nn.Linear(tdim, tdim))
        self.inc = nn.Conv2d(1, base, 3, padding=1)
        self.down1 = _ResBlock(base, base, tdim)
        self.pool1 = nn.Conv2d(base, 2 * base, 3, stride=2, padding=1)
        self.down2 = _ResBlock(2 * base, 2 * base, tdim)
        self.pool2 = nn.Conv2d(2 * base, 4 * base, 3, stride=2, padding=1)
        self.mid = _ResBlock(4 * base, 4 * base, tdim)
        self.up2 = _ResBlock(6 * base, 2 * base, tdim)
        self.up1 = _ResBlock(3 * base, base, tdim)
        self.out_norm = nn.GroupNorm(8, base)
        self.out = nn.Conv2d(base, 1, 3, padding=1)

    def forward(self, x, t):
        emb = self.time_mlp(_time_embedding(t, self.base))
        s1 = self.down1(self.inc(x), emb)
        s2 = self.down2(self.pool1(s1), emb)
        h = self.mid(self.pool2(s2), emb)
        h = self.up2(torch.cat([F.interpolate(h, scale_factor=2.0, mode="nearest"), s2], dim=1), emb)
        h = self.up1(torch.cat([F.interpolate(h, scale_factor=2.0, mode="nearest"), s1], dim=1), emb)
        return self.out(F.silu(self.out_norm(h)))
