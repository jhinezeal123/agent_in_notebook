# %% [markdown]
# LayerNorm chuẩn hoá **mỗi token riêng**: trung bình và phương sai lấy trên $d$ feature của token đó. BatchNorm thì ngược lại: lấy trên các mẫu của batch, cho từng feature.

# %%
import numpy as np
import matplotlib.pyplot as plt

rng = np.random.default_rng(0)
x = rng.normal(loc=[[3.0], [-2.0], [0.5]], scale=[[2.0], [0.3], [5.0]], size=(3, 64))
fig, ax = plt.subplots(1, 2, figsize=(10, 3), sharey=True)
for i in range(3):
    ax[0].hist(x[i], bins=20, alpha=0.6, label=f"token {i}")
    z = (x[i] - x[i].mean()) / np.sqrt(x[i].var() + 1e-5)
    ax[1].hist(z, bins=20, alpha=0.6, label=f"token {i}")
ax[0].set_title("Feature của 3 token, trước")
ax[1].set_title("Sau khi chuẩn hoá từng token")
ax[0].legend()
plt.tight_layout()
plt.show()

# %%
# Trục nào bị chuẩn hoá? (B = 6 mẫu, d = 8 feature)
grid = np.zeros((6, 8))
fig, ax = plt.subplots(1, 2, figsize=(9, 3))
ln = grid.copy(); ln[2, :] = 1
bn = grid.copy(); bn[:, 5] = 1
ax[0].imshow(ln, cmap="Blues"); ax[0].set_title("LayerNorm: một hàng (một token)")
ax[1].imshow(bn, cmap="Oranges"); ax[1].set_title("BatchNorm: một cột (một feature)")
for a in ax:
    a.set_xlabel("feature (d)"); a.set_ylabel("mẫu / token")
plt.tight_layout()
plt.show()
