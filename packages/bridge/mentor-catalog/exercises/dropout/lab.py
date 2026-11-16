# %% [markdown]
# **Dropout trông như thế nào.** Lấy một "ảnh" activation mượt, rồi bỏ ngẫu nhiên từng phần tử với xác suất $p$. Chú ý thang màu: các phần tử còn lại **sáng hơn** ảnh gốc khi có phóng $\frac{1}{1-p}$.

# %%
import numpy as np
import matplotlib.pyplot as plt

rng = np.random.default_rng(0)
yy, xx = np.mgrid[0:40, 0:40]
act = 1 + np.sin(xx / 6) * np.cos(yy / 9)

fig, ax = plt.subplots(1, 4, figsize=(13, 3.2))
im = ax[0].imshow(act, vmin=0, vmax=6, cmap="magma"); ax[0].set_title("activation gốc")
for a, p in zip(ax[1:], [0.1, 0.5, 0.8]):
    keep = rng.random(act.shape) < 1 - p
    a.imshow(act * keep / (1 - p), vmin=0, vmax=6, cmap="magma")
    a.set_title(f"p = {p}: giữ {keep.mean():.0%}, phóng ×{1 / (1 - p):.1f}")
for a in ax:
    a.axis("off")
fig.colorbar(im, ax=ax, shrink=0.8)
plt.show()

# %% [markdown]
# **Vì sao phải phóng lên.** Lớp sau nhận tổng $s = \sum_i w_i h_i$. Lúc eval không còn dropout, nên $s$ có một giá trị cố định (đường đứng màu đen). Lúc train, mỗi lần lấy mask lại ra một $s$ khác; ta vẽ histogram của 3000 lần lấy mask. Lớp sau được train trên phân phối nào thì lúc eval nên thấy đúng phân phối đó **ở trung bình**.

# %%
n, p = 200, 0.5
h = np.abs(rng.normal(size=n))
w = rng.normal(loc=0.2, size=n)
s_eval = w @ h
draws = rng.random((3000, n)) < 1 - p
s_plain = (draws * h) @ w
s_inverted = (draws * h / (1 - p)) @ w

plt.figure(figsize=(7, 3.2))
plt.hist(s_plain, bins=50, alpha=0.6, label="train, chỉ nhân mask")
plt.hist(s_inverted, bins=50, alpha=0.6, label="train, mask rồi chia (1 − p)")
plt.axvline(s_eval, color="black", lw=2, label="eval")
plt.legend(fontsize=8); plt.title(f"Tổng s ở lớp sau (p = {p})")
plt.tight_layout()
plt.show()

# %% [markdown]
# **Trung bình được giữ, phương sai thì không.** Với $p$ tăng dần: trung bình của $s$ khi train (đã phóng) so với giá trị eval, và độ lệch chuẩn của nó. Hãy kể cho mentor: điều gì xảy ra với lớp ngay sau dropout khi chuyển từ train sang eval, nếu lớp đó nhạy với phương sai (vd. BatchNorm)?

# %%
ps = np.linspace(0, 0.9, 10)
means, stds = [], []
for q in ps:
    d = rng.random((3000, n)) < 1 - q
    s = (d * h / (1 - q)) @ w
    means.append(s.mean()); stds.append(s.std())
fig, ax = plt.subplots(1, 2, figsize=(10, 3))
ax[0].plot(ps, means, "o-"); ax[0].axhline(s_eval, color="black", ls="--"); ax[0].set_title("trung bình của s (train)")
ax[1].plot(ps, stds, "o-", color="tab:red"); ax[1].set_title("std của s (train)")
for a in ax:
    a.set_xlabel("p")
plt.tight_layout()
plt.show()
