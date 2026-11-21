# %% [markdown]
# # Chẩn đoán triệu chứng: tương đồng cosine vượt biên [-1, 1]
# Cosine similarity của hai vector bất kỳ luôn phải nằm trong $[-1, 1]$ và không đổi khi nhân một vector với hằng số dương.

# %%
import numpy as np
import matplotlib.pyplot as plt

rng = np.random.default_rng(1)
X = rng.normal(size=(6, 4))
Y = rng.normal(size=(6, 4)) * 5.0
nx = np.maximum(np.linalg.norm(X, axis=1, keepdims=True), 1e-8)
buggy = (X / nx) @ Y.T

fig, ax = plt.subplots(figsize=(5, 3))
im = ax.imshow(buggy, cmap="coolwarm")
plt.colorbar(im, ax=ax)
ax.set_title(f"Đầu ra bị lỗi: min={buggy.min():.2f}, max={buggy.max():.2f}")
plt.tight_layout()
plt.show()
