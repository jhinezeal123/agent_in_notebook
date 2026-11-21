# %% [markdown]
# # Trực giác 1 bước Lloyd: gán cụm (vùng Voronoi) rồi dời tâm về trọng tâm cụm

# %%
import numpy as np
import matplotlib.pyplot as plt

rng = np.random.default_rng(3)
X = np.vstack([
    rng.normal(loc=[-2, -1], scale=0.6, size=(30, 2)),
    rng.normal(loc=[2, 1.5], scale=0.6, size=(30, 2)),
    rng.normal(loc=[0, -2.5], scale=0.6, size=(30, 2)),
])
c0 = np.array([[-1.5, 1.5], [1.0, 0.0], [1.5, -2.0]])
d2 = ((X[:, None, :] - c0[None, :, :]) ** 2).sum(axis=-1)
lab = d2.argmin(axis=1)
c1 = np.array([X[lab == k].mean(axis=0) for k in range(3)])

plt.figure(figsize=(5, 4))
plt.scatter(X[:, 0], X[:, 1], c=lab, s=18, alpha=0.7)
plt.scatter(c0[:, 0], c0[:, 1], c="black", marker="x", s=90, label="Tâm cũ")
plt.scatter(c1[:, 0], c1[:, 1], c="red", marker="*", s=130, label="Tâm mới")
plt.legend()
plt.title("Dịch chuyển tâm cụm sau một bước Lloyd")
plt.tight_layout()
plt.show()
