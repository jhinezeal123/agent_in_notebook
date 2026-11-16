# %% [markdown]
# **Công thức.** Với $x_i, y_j \in \mathbb{R}^d$:
#
# $$D_{ij} = \sum_{k=1}^{d} (x_{ik} - y_{jk})^2 = \lVert x_i \rVert^2 + \lVert y_j \rVert^2 - 2\, x_i^\top y_j$$
#
# Câu hỏi để tự nghĩ: muốn trừ *mọi* cặp $(i, j)$ cùng lúc thì `X` và `Y` phải có shape thế nào?

# %%
import numpy as np
import matplotlib.pyplot as plt

rng = np.random.default_rng(0)
X = rng.normal(size=(5, 2))
Y = rng.normal(size=(7, 2))
print("X có shape", X.shape, "| X[:, None, :] có shape", X[:, None, :].shape)
print("Y có shape", Y.shape, "| Y[None, :, :] có shape", Y[None, :, :].shape)
print("Hiệu X[:, None, :] - Y[None, :, :] có shape", (X[:, None, :] - Y[None, :, :]).shape)

# %%
# Cách chậm (vòng lặp) để bạn nhìn thấy đích cần đến.
D_loop = np.array([[((x - y) ** 2).sum() for y in Y] for x in X])
fig, ax = plt.subplots(1, 2, figsize=(10, 3.6))
ax[0].scatter(*X.T, label="X (n=5)")
ax[0].scatter(*Y.T, marker="x", s=70, label="Y (m=7)")
for i, x in enumerate(X):
    ax[0].annotate(f"x{i}", x, textcoords="offset points", xytext=(4, 4))
ax[0].legend()
ax[0].set_title("Hai tập điểm")
im = ax[1].imshow(D_loop, cmap="viridis")
ax[1].set_title("D[i, j] tính bằng vòng lặp")
ax[1].set_xlabel("j (điểm của Y)")
ax[1].set_ylabel("i (điểm của X)")
fig.colorbar(im, ax=ax[1])
plt.tight_layout()
plt.show()
