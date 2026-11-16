# %% [markdown]
# **Broadcasting trong PyTorch giống hệt numpy.** Tensor shape `(4, 1)` gặp tensor shape `(1, 5)` thành `(4, 5)`: trục nào có kích thước 1 thì được "kéo dài" cho khớp. Hình trái là bảng cộng $a_i + b_j$, hình phải là bảng khoảng cách $|a_i - b_j|$ của hai dãy điểm trên trục số. Bài của bạn là phiên bản nhiều chiều: mỗi điểm có $D$ toạ độ, nên cần thêm một trục nữa.

# %%
import numpy as np
import torch
import torch.nn.functional as F
import matplotlib.pyplot as plt

a = torch.tensor([0.0, 1.0, 2.0, 3.0])
b = torch.tensor([0.0, 0.5, 1.5, 2.5, 4.0])
table = a.view(4, 1) + b.view(1, 5)
gap = (a.view(4, 1) - b.view(1, 5)).abs()
print("shape:", tuple(a.view(4, 1).shape), "+", tuple(b.view(1, 5).shape), "->", tuple(table.shape))

fig, ax = plt.subplots(1, 2, figsize=(9, 3))
for axis, m, title in [(ax[0], table, "a.view(4, 1) + b.view(1, 5)"), (ax[1], gap, "|a_i − b_j|")]:
    axis.imshow(m.numpy(), cmap="viridis")
    for i in range(4):
        for j in range(5):
            axis.text(j, i, f"{float(m[i, j]):.1f}", ha="center", va="center", color="white", fontsize=8)
    axis.set_title(title); axis.set_xlabel("j (theo b)"); axis.set_ylabel("i (theo a)")
plt.tight_layout()
plt.show()

# %% [markdown]
# **Vì sao không lấy `log` của `softmax`.** Nhân một vector logits cố định với hệ số $s$ ngày càng lớn. Xác suất của lớp kém nhất nhỏ dần tới mức `float32` làm tròn thành đúng 0, và `log(0) = -inf`. Còn log-xác suất tính thẳng bằng $z_c - \log\sum_j e^{z_j}$ (log-sum-exp ổn định) thì luôn hữu hạn.

# %%
z = torch.randn(10, generator=torch.Generator().manual_seed(0))
worst = int(z.argmin())
scales = np.logspace(0, 3, 40)
naive, stable = [], []
for s in scales:
    zs = z * float(s)
    naive.append(float(torch.log(torch.softmax(zs, dim=0))[worst]))
    stable.append(float(zs[worst] - torch.logsumexp(zs, dim=0)))
naive = np.array(naive)
plt.figure(figsize=(7, 3.2))
plt.plot(scales, stable, label="log-sum-exp ổn định")
finite = np.isfinite(naive)
plt.plot(scales[finite], naive[finite], "o", ms=3, label="log(softmax)")
if (~finite).any():
    plt.axvline(scales[~finite][0], color="red", ls="--", label="log(softmax) thành -inf từ đây")
plt.xscale("log"); plt.xlabel("hệ số s"); plt.ylabel("log p của lớp kém nhất")
plt.legend(fontsize=8); plt.tight_layout()
plt.show()

# %% [markdown]
# **"Nhặt" lớp đúng của từng hàng.** Mỗi hàng là một mẫu, mỗi cột là một lớp; dấu ✕ đánh dấu lớp đúng `targets[b]`. Kết quả của `pick_logprobs` là đúng các ô có dấu ✕, mỗi hàng một số. `gather` làm việc này: nó cần một index có cùng số chiều với tensor nguồn, nên với `(B, C)` index phải có shape `(B, 1)`.

# %%
logits = torch.randn(6, 5, generator=torch.Generator().manual_seed(1))
targets = torch.tensor([2, 0, 4, 1, 1, 3])
logp = logits - torch.logsumexp(logits, dim=-1, keepdim=True)
plt.figure(figsize=(5, 3.5))
plt.imshow(logp.numpy(), cmap="Blues")
plt.colorbar(label="log p")
plt.scatter(targets.numpy(), np.arange(6), marker="x", color="red", s=80)
plt.xlabel("lớp c"); plt.ylabel("mẫu b"); plt.title("log p theo trục cuối, ✕ = lớp đúng")
plt.tight_layout()
plt.show()
