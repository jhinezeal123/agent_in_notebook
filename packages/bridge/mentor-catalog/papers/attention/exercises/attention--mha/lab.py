# %% [markdown]
# **Vì sao chia cho $\sqrt{d_k}$ (§3.2.1, chú thích 4).** Nếu các thành phần của $q$ và $k$ độc lập, trung bình 0, phương sai 1, thì $q \cdot k = \sum_{j=1}^{d_k} q_j k_j$ có phương sai $d_k$. Hình trái: độ lệch chuẩn của điểm $q\cdot k$ lớn đúng như $\sqrt{d_k}$ (đường đứt). Hình phải: một query nhìn 10 key; không chia thì khi $d_k$ lớn softmax gần như dồn hết vào một key (vùng "bão hoà", gradient gần 0), chia cho $\sqrt{d_k}$ thì mức tập trung giữ nguyên dù $d_k$ đổi.

# %%
import numpy as np
import torch
import matplotlib.pyplot as plt

torch.manual_seed(0)
dks = [4, 16, 64, 256, 1024]
std_raw, peak_raw, peak_scaled = [], [], []
for dk in dks:
    q = torch.randn(500, 1, dk)
    keys = torch.randn(500, 10, dk)
    s = (q * keys).sum(-1)                      # (500, 10): điểm của 1 query với 10 key
    std_raw.append(float(s.std()))
    peak_raw.append(float(torch.softmax(s, -1).max(-1).values.mean()))
    peak_scaled.append(float(torch.softmax(s / dk ** 0.5, -1).max(-1).values.mean()))

fig, ax = plt.subplots(1, 2, figsize=(10, 3.2))
ax[0].plot(dks, std_raw, "o-", label="std của q·k")
ax[0].plot(dks, np.sqrt(dks), "k--", label="√d_k")
ax[0].set_xscale("log"); ax[0].set_yscale("log"); ax[0].set_xlabel("d_k"); ax[0].legend(fontsize=8)
ax[1].plot(dks, peak_raw, "o-", label="softmax(q·k)")
ax[1].plot(dks, peak_scaled, "o-", label="softmax(q·k / √d_k)")
ax[1].axhline(0.1, color="gray", ls=":", label="đều tuyệt đối (1/10)")
ax[1].set_xscale("log"); ax[1].set_xlabel("d_k"); ax[1].set_ylabel("trọng số lớn nhất (trung bình)")
ax[1].legend(fontsize=8)
plt.tight_layout()
plt.show()

# %% [markdown]
# **Mask broadcast tới điểm attention `(B, n_heads, Tq, Tk)`.** Mask padding chỉ biết key nào là PAD, nên có shape `(B, 1, 1, Tk)`: nó được lặp lại cho mọi head và mọi query. Mask causal chỉ phụ thuộc vị trí, shape `(T, T)`: lặp lại cho mọi câu và mọi head. Ô xanh là được nhìn (`True`), ô trắng là bị che.

# %%
B, Tq, Tk = 3, 4, 6
lengths = torch.tensor([6, 4, 2])
pad = torch.arange(Tk)[None, :] < lengths[:, None]      # (B, Tk)
pad4 = pad[:, None, None, :]                             # (B, 1, 1, Tk)
seen = pad4.expand(B, 2, Tq, Tk)                         # như điểm attention với 2 head
tri = torch.tril(torch.ones(Tk, Tk, dtype=torch.bool))
print("mask padding:", tuple(pad4.shape), "-> sau broadcast:", tuple(seen.shape))

fig, ax = plt.subplots(1, B + 1, figsize=(12, 2.8))
for b in range(B):
    ax[b].imshow(seen[b, 0].int(), cmap="Greens", vmin=0, vmax=1)
    ax[b].set_title(f"padding, câu {b} (dài {int(lengths[b])})", fontsize=9)
    ax[b].set_xlabel("key"); ax[b].set_ylabel("query")
ax[B].imshow(tri.int(), cmap="Purples", vmin=0, vmax=1)
ax[B].set_title("causal (T = 6)", fontsize=9); ax[B].set_xlabel("key")
plt.tight_layout()
plt.show()
