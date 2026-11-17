# CIFAR-10 thu nhỏ: ảnh màu 3 x 32 x 32, 10 lớp (máy bay, ô tô, chim, mèo, hươu, chó, ếch, ngựa, tàu, xe tải).
CIFAR_MEAN = (0.4914, 0.4822, 0.4465)
CIFAR_STD = (0.2470, 0.2435, 0.2616)
NUM_CLASSES = 10


def load_cifar10(n, train=True):
    """n ảnh đầu tiên của tập train (hoặc tập test khi train=False) của CIFAR-10: (x, y) với x float32 shape (n, 3, 32, 32) đã trừ mean chia std theo kênh, y int64 shape (n,) nhãn 0..9.
    Cần Internet ở lần chạy đầu: tải từ Hugging Face (nhanh, khoảng 130 MB, lưu trong bộ nhớ đệm của Hugging Face); không được thì từ máy chủ gốc qua
    torchvision (về thư mục cifar_data, có thể rất chậm). Không có Internet thì dùng tạm bộ chữ số 8x8 của scikit-learn
    (1500 ảnh train, 297 ảnh test, phóng to lên 32 x 32 và lặp thành 3 kênh: dễ hơn và nhòe hơn CIFAR-10 thật, hiện tượng của paper yếu hơn nữa) và in một dòng cảnh báo."""
    import numpy as np
    try:
        try:
            from datasets import load_dataset
            ds = load_dataset("uoft-cs/cifar10", split="train" if train else "test").select(range(n))
            x = torch.tensor(np.stack([np.asarray(im.convert("RGB")) for im in ds["img"]])).permute(0, 3, 1, 2).float() / 255.0
            y = torch.tensor(ds["label"], dtype=torch.long)
        except Exception:
            from torchvision import datasets
            ds = datasets.CIFAR10("cifar_data", train=train, download=True)
            x = torch.tensor(ds.data[:n]).permute(0, 3, 1, 2).float() / 255.0
            y = torch.tensor(ds.targets[:n], dtype=torch.long)
    except Exception as e:
        from sklearn.datasets import load_digits
        print(f"Không tải được CIFAR-10 ({type(e).__name__}): dùng tạm bộ chữ số 8x8 của scikit-learn, dễ hơn và ít ảnh hơn.")
        d = load_digits()
        imgs = torch.tensor(d.images, dtype=torch.float32) / 16.0
        labels = torch.tensor(d.target, dtype=torch.long)
        part = slice(0, 1500) if train else slice(1500, None)
        imgs, labels = imgs[part][:n], labels[part][:n]
        x = F.interpolate(imgs.unsqueeze(1), size=(32, 32), mode="bilinear", align_corners=False).repeat(1, 3, 1, 1)
        y = labels
    mean = torch.tensor(CIFAR_MEAN).view(1, 3, 1, 1)
    std = torch.tensor(CIFAR_STD).view(1, 3, 1, 1)
    return (x - mean) / std, y


class PlainBlock(nn.Module):
    """Khối "plain" của paper (§4.1, §4.2): giống hệt ResidualBlock (conv 3x3 stride, BN, ReLU, conv 3x3, BN) nhưng KHÔNG có đường tắt:
    y = ReLU(BN2(conv2(ReLU(BN1(conv1(x))))). Cùng thuộc tính conv1, bn1, conv2, bn2 như ResidualBlock, nhưng không có shortcut (không projection).
    Mạng plain là mạng residual đã bỏ hết phép cộng với x: cùng độ sâu, cùng số conv 3x3, chỉ thiếu đường tắt."""

    def __init__(self, in_ch, out_ch, stride=1):
        super().__init__()
        self.conv1 = nn.Conv2d(in_ch, out_ch, kernel_size=3, stride=stride, padding=1, bias=False)
        self.bn1 = nn.BatchNorm2d(out_ch)
        self.conv2 = nn.Conv2d(out_ch, out_ch, kernel_size=3, stride=1, padding=1, bias=False)
        self.bn2 = nn.BatchNorm2d(out_ch)

    def forward(self, x):
        out = F.relu(self.bn1(self.conv1(x)))
        return F.relu(self.bn2(self.conv2(out)))


@torch.no_grad()
def evaluate(model, x, y, batch=500):
    """(accuracy, error) của model trên (x, y) ở chế độ eval, cộng dồn theo từng lô `batch` ảnh; dữ liệu và mô hình có thể ở hai thiết bị khác nhau.
    error = 1 - accuracy (giữ như cách paper báo: phần trăm ảnh đoán sai). Trả lại chế độ train/eval như lúc gọi."""
    device = next(model.parameters()).device
    was_training = model.training
    model.eval()
    correct = 0
    for i in range(0, len(x), batch):
        pred = model(x[i:i + batch].to(device)).argmax(dim=1).cpu()
        correct += int((pred == y[i:i + batch].cpu()).sum())
    model.train(was_training)
    acc = correct / len(x)
    return acc, 1.0 - acc


def plot_curves(curves, title="", ylabel=""):
    """Vẽ nhiều đường theo epoch. curves: dict tên -> danh sách số (một số mỗi epoch)."""
    import matplotlib.pyplot as plt
    for name, values in curves.items():
        plt.plot(range(1, len(values) + 1), values, label=name)
    plt.xlabel("epoch")
    plt.ylabel(ylabel)
    plt.title(title)
    plt.legend()
    plt.show()
