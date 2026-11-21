# %% [markdown]
# # Chẩn đoán triệu chứng: ma trận khoảng cách theo cặp
# Khi $X$ có $N=4$ điểm trong $\mathbb{R}^3$ và $Y$ có $M=5$ điểm trong $\mathbb{R}^3$,
# ma trận khoảng cách đúng phải có shape $(4, 5)$, không âm, và nếu $X = Y$ thì đường chéo bằng $0$.

# %%
import numpy as np
import matplotlib.pyplot as plt

rng = np.random.default_rng(0)
X = rng.normal(size=(4, 3))
Y = rng.normal(size=(5, 3))
diff = X[:, None, :] - Y[None, :, :]
print("Shape của hiệu X[:, None, :] - Y[None, :, :]:", diff.shape)

fig, ax = plt.subplots(1, 2, figsize=(7, 3))
ax[0].imshow((diff ** 2).sum(axis=0))
ax[0].set_title(f"Cộng theo trục 0 → shape {(diff ** 2).sum(axis=0).shape}")
ax[1].imshow(np.zeros((4, 5)))
ax[1].set_title("Shape kỳ vọng: (4, 5)")
plt.tight_layout()
plt.show()
