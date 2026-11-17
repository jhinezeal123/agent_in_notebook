# ViT thu nhỏ trên chữ số MNIST: ảnh xám 1 x 28 x 28, 10 lớp (chữ số 0 đến 9).
IMG_SIZE = 28
NUM_CLASSES = 10
MNIST_MEAN, MNIST_STD = 0.1307, 0.3081


def load_mnist(n, train=True):
    """n ảnh đầu tiên của tập train (hoặc tập test khi train=False) của MNIST: (x, y) với x float32 shape (n, 1, 28, 28) đã trừ mean chia std (nền đen thành số âm), y int64 shape (n,) nhãn 0..9.
    Cần Internet ở lần chạy đầu (torchvision tải MNIST về thư mục mnist_data). Không có Internet thì dùng tạm bộ chữ số 8x8 của scikit-learn
    (1500 ảnh train, 297 ảnh test, phóng to lên 28 x 28: nhòe hơn và ít ảnh hơn MNIST thật) và in một dòng cảnh báo."""
    try:
        from torchvision import datasets
        ds = datasets.MNIST("mnist_data", train=train, download=True)
        x = ds.data[:n].float().div(255.0).unsqueeze(1)
        y = ds.targets[:n].long()
    except Exception as e:
        from sklearn.datasets import load_digits
        print(f"Không tải được MNIST ({type(e).__name__}): dùng tạm bộ chữ số 8x8 của scikit-learn, nhòe hơn và ít ảnh hơn.")
        d = load_digits()
        imgs = torch.tensor(d.images, dtype=torch.float32) / 16.0
        labels = torch.tensor(d.target, dtype=torch.long)
        part = slice(0, 1500) if train else slice(1500, None)
        imgs, labels = imgs[part][:n], labels[part][:n]
        x = F.interpolate(imgs.unsqueeze(1), size=(28, 28), mode="bilinear", align_corners=False)
        y = labels
    return (x - MNIST_MEAN) / MNIST_STD, y


@torch.no_grad()
def evaluate(model, x, y, batch=500):
    """Accuracy của model (logits (B, 10)) trên (x, y) ở chế độ eval, cộng dồn theo từng lô `batch` ảnh; dữ liệu và mô hình có thể ở hai thiết bị khác nhau. Trả lại chế độ train/eval như lúc gọi."""
    device = next(model.parameters()).device
    was_training = model.training
    model.eval()
    correct = 0
    for i in range(0, len(x), batch):
        pred = model(x[i:i + batch].to(device)).argmax(dim=1).cpu()
        correct += int((pred == y[i:i + batch].cpu()).sum())
    model.train(was_training)
    return correct / len(x)


@torch.no_grad()
def ms_per_image(model, x, repeats=5):
    """Thời gian forward trung bình (mili giây) mỗi ảnh, chế độ eval, trên thiết bị của mô hình, sau một lượt khởi động. x: (B, 1, 28, 28).
    Số đo này nhiễu (máy bận, GPU nóng lên): chạy vài lần và nhìn tỷ lệ giữa hai mô hình, đừng tin từng số."""
    import time
    device = next(model.parameters()).device
    was_training = model.training
    model.eval()
    x = x.to(device)
    model(x)
    if device.type == "cuda":
        torch.cuda.synchronize()
    start = time.perf_counter()
    for _ in range(repeats):
        model(x)
    if device.type == "cuda":
        torch.cuda.synchronize()
    model.train(was_training)
    return 1000.0 * (time.perf_counter() - start) / (repeats * len(x))


def show_patch_grid(image, patch_size, title=""):
    """Vẽ một ảnh (1, H, W) hoặc (H, W) với lưới patch_size x patch_size chồng lên, để thấy ảnh bị cắt thành bao nhiêu token."""
    import matplotlib.pyplot as plt
    img = image.detach().cpu().float().reshape(image.shape[-2], image.shape[-1])
    plt.imshow(img, cmap="gray")
    for k in range(0, img.shape[0] + 1, patch_size):
        plt.axhline(k - 0.5, color="tab:red", lw=0.6)
        plt.axvline(k - 0.5, color="tab:red", lw=0.6)
    plt.title(title)
    plt.axis("off")
    plt.show()


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
