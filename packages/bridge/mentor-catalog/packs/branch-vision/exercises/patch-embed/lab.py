# %% [markdown]
# **Ảnh thành "câu".** ViT không đọc ảnh pixel-by-pixel mà đọc từng **ô vuông** `p × p`, mỗi ô là một "từ". Hình dưới: một ảnh tổng hợp 32×48 (3 kênh) với lưới patch $p = 8$. Số trên mỗi ô là **chỉ số của patch** theo thứ tự mà đề yêu cầu. Hãy nhìn và tự trả lời trước khi code: patch số 5 nằm ở hàng nào, cột nào của lưới? Từ ảnh $H \times W$ và $p$, lưới có mấy hàng, mấy cột, và chỉ số của patch ở hàng $r$, cột $s$ là gì?

# %%
import numpy as np
import matplotlib.pyplot as plt

H, W, C, p = 32, 48, 3, 8
yy, xx = np.mgrid[0:H, 0:W]
img = np.stack([xx / W, yy / H, 0.5 + 0.5 * np.sin((xx + yy) / 5.0)])  # (C, H, W)
img[:, 10:22, 16:30] = np.array([1.0, 0.9, 0.1]).reshape(3, 1, 1)  # một hình chữ nhật vàng cho dễ thấy

fig, ax = plt.subplots(figsize=(6.4, 4.4))
ax.imshow(np.clip(img.transpose(1, 2, 0), 0, 1))
for i in range(0, H + 1, p):
    ax.axhline(i - 0.5, color="white", lw=1)
for j in range(0, W + 1, p):
    ax.axvline(j - 0.5, color="white", lw=1)
rows, cols = H // p, W // p
for r in range(rows):
    for s in range(cols):
        ax.text(s * p + p / 2 - 0.5, r * p + p / 2 - 0.5, str(r * cols + s), ha="center", va="center", color="black", fontsize=11, fontweight="bold",
                bbox=dict(boxstyle="round,pad=0.15", fc="white", ec="none", alpha=0.7))
ax.set_title(f"lưới {rows}×{cols} = {rows * cols} patch, p = {p}", fontsize=10)
ax.set_xticks([]); ax.set_yticks([])
plt.tight_layout()
plt.show()

# %% [markdown]
# **Bên trong một patch.** Một patch là khối `(C, p, p)`. Để đưa vào một lớp Linear, nó phải duỗi thành một vector dài `C·p·p`. Hình dưới lấy patch số 0 của ảnh ở trên (góc trên-trái) và duỗi nó **theo thứ tự (C, p, p)**: hàng trên là ba kênh xếp cạnh nhau (mỗi kênh một ảnh `p × p`), hàng dưới là vector sau khi duỗi, vẽ thành một dải (màu = giá trị). Nhìn dải đó: nó gồm ba đoạn lớn bằng nhau, mỗi đoạn lại gồm $p$ đoạn con. Đoạn lớn ứng với trục nào, đoạn con ứng với trục nào? Nếu thay vì đó ta duỗi theo thứ tự (p, p, C) thì dải sẽ trông thế nào, và hai cách có cho cùng một Linear được không nếu bạn không đổi gì khác?

# %%
patch0 = img[:, 0:p, 0:p]  # (C, p, p): patch góc trên-trái
vec = patch0.reshape(-1)
fig = plt.figure(figsize=(8.6, 3.4))
gs = fig.add_gridspec(2, C, height_ratios=[3, 1])
for c in range(C):
    a = fig.add_subplot(gs[0, c])
    a.imshow(patch0[c], vmin=0, vmax=1, cmap="viridis")
    a.set_title(f"kênh {c}", fontsize=9); a.set_xticks([]); a.set_yticks([])
a = fig.add_subplot(gs[1, :])
a.imshow(vec[None, :], aspect="auto", vmin=0, vmax=1, cmap="viridis")
for k in range(1, C):
    a.axvline(k * p * p - 0.5, color="white", lw=2)
a.set_yticks([]); a.set_xlabel(f"vector duỗi: {C}·{p}·{p} = {C * p * p} số")
plt.tight_layout()
plt.show()

# %% [markdown]
# **Chuỗi dài bao nhiêu?** Số token là $N = (224/p)^2$ cho ảnh 224×224. Self-attention so mọi cặp token nên tốn cỡ $N^2$. Hình dưới vẽ $N$ (cột trái) và $N^2$ (cột phải) cho các cỡ patch quen thuộc. Chọn patch 8 thay vì 16 thì tốn gấp bao nhiêu lần? Đây là lý do ViT gốc dùng patch 16 hoặc 32 chứ không đọc từng pixel.

# %%
ps = np.array([4, 8, 16, 32, 56])
N = (224 // ps) ** 2
fig, ax = plt.subplots(1, 2, figsize=(8.6, 3.2))
ax[0].bar([str(v) for v in ps], N, color="tab:blue")
ax[0].set_xlabel("patch size p"); ax[0].set_ylabel("số token N"); ax[0].set_yscale("log")
ax[1].bar([str(v) for v in ps], N.astype(float) ** 2, color="tab:red")
ax[1].set_xlabel("patch size p"); ax[1].set_ylabel("N² (số cặp token)"); ax[1].set_yscale("log")
plt.tight_layout()
plt.show()
