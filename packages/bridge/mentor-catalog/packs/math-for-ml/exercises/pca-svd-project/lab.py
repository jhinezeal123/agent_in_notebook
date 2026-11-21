# %% [markdown]
# # Trực giác hình học của PCA bằng SVD
# Quy tâm đám mây điểm 2D rồi xoay theo các trục trực giao $V^\top$: trục đầu tiên bắt phương sai lớn nhất.

# %%
import numpy as np
import matplotlib.pyplot as plt

rng = np.random.default_rng(0)
t_pts = rng.normal(size=(120, 2))
A = np.array([[2.2, 0.8], [0.8, 0.5]])
X = t_pts @ A.T + np.array([3.0, -2.0])
Xc = X - X.mean(axis=0, keepdims=True)
_, S, Vt = np.linalg.svd(Xc, full_matrices=False)

plt.figure(figsize=(5, 4))
plt.scatter(Xc[:, 0], Xc[:, 1], s=14, alpha=0.6)
for i, color in enumerate(["crimson", "teal"]):
    vec = Vt[i] * (S[i] / np.sqrt(len(X))) * 2.0
    plt.arrow(0, 0, vec[0], vec[1], width=0.05, color=color, label=f"PC{i+1} (σ={S[i]:.1f})")
plt.axis("equal")
plt.legend()
plt.title("Hai thành phần chính của đám mây điểm 2D sau khi quy tâm")
plt.tight_layout()
plt.show()
