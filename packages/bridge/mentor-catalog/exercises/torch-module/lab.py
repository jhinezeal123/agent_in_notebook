# %% [markdown]
# **Soi một `nn.Linear` thật.** Một module giữ tham số của nó trong một danh sách mà `parameters()`, `state_dict()` và optimizer đều đọc được. Chú ý thứ tự trục của `weight`: **(out, in)**, ngược với cách viết $x W$ quen thuộc ở numpy. Histogram cho thấy cách `nn.Linear(100, 50)` khởi tạo weight: đều trong một khoảng, hai vạch đỏ là $\pm 1/\sqrt{100}$.

# %%
import numpy as np
import torch
import torch.nn as nn
import matplotlib.pyplot as plt

torch.manual_seed(0)
lin = nn.Linear(3, 2)
for name, p in lin.named_parameters():
    print(f"{name:7s} shape {tuple(p.shape)}  requires_grad={p.requires_grad}")
print("state_dict:", list(lin.state_dict().keys()))

big = nn.Linear(100, 50)
plt.figure(figsize=(6, 3))
plt.hist(big.weight.detach().numpy().ravel(), bins=40)
for v in [-0.1, 0.1]:
    plt.axvline(v, color="red", ls="--")
plt.title("weight của nn.Linear(100, 50)"); plt.xlabel("giá trị")
plt.tight_layout()
plt.show()

# %% [markdown]
# **Vì sao khoảng khởi tạo co theo $1/\sqrt{\text{in}}$.** Mỗi đầu ra của một lớp tuyến tính là tổng của `in` số hạng; nếu trọng số có độ lớn cỡ 1 thì tổng lớn cỡ $\sqrt{\text{in}}$, qua nhiều lớp là nổ. Đẩy một batch qua 10 lớp (rộng 256, có ReLU) với ba cách khởi tạo, đo độ lệch chuẩn của activation ở mỗi lớp (trục dọc theo thang log). Chia theo $\sqrt{\text{in}}$ là thứ quan trọng nhất; hằng số đứng trước thì tuỳ hàm kích hoạt (Kaiming chọn $\sqrt{2/\text{in}}$ để bù cho ReLU).

# %%
width, depth = 256, 10
x = torch.randn(512, width)
inits = {
    "randn (std 1)": lambda: torch.randn(width, width),
    "đều ±1/√in (như nn.Linear)": lambda: torch.empty(width, width).uniform_(-width ** -0.5, width ** -0.5),
    "chuẩn, std √(2/in) (Kaiming)": lambda: torch.randn(width, width) * (2 / width) ** 0.5,
}
plt.figure(figsize=(7, 3.5))
for label, make in inits.items():
    h, stds = x, []
    for _ in range(depth):
        h = torch.relu(h @ make().T)
        stds.append(float(h.std()))
    plt.plot(range(1, depth + 1), stds, "o-", label=label)
plt.yscale("log"); plt.xlabel("lớp"); plt.ylabel("std của activation")
plt.legend(fontsize=8); plt.tight_layout()
plt.show()
