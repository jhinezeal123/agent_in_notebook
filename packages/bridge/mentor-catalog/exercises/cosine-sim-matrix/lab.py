# %% [markdown]
# Nhắc lại bài trước: ma trận khoảng cách bình phương $D_{ij} = \lVert x_i - y_j \rVert^2$. Dưới đây các điểm của `X` có **độ dài rất khác nhau** (cùng vài hướng, nhưng xa gốc toạ độ khác nhau).
#
# Cosine chỉ nhìn **góc** giữa hai vector. Trước khi code, hãy đoán: heatmap cosine sẽ khác heatmap khoảng cách ở đâu? Và nếu mọi điểm đều nằm trên đường tròn đơn vị thì sao?

# %%
import numpy as np
import matplotlib.pyplot as plt

rng = np.random.default_rng(0)
angles_x = rng.uniform(0, 2 * np.pi, size=5)
radii = np.array([0.3, 1.0, 2.5, 4.0, 0.6])
X = np.stack([np.cos(angles_x), np.sin(angles_x)], axis=1) * radii[:, None]
angles_y = rng.uniform(0, 2 * np.pi, size=7)
Y = np.stack([np.cos(angles_y), np.sin(angles_y)], axis=1) * rng.uniform(0.5, 3.0, size=(7, 1))
D = np.array([[((x - y) ** 2).sum() for y in Y] for x in X])

fig, ax = plt.subplots(1, 2, figsize=(10, 3.8))
ax[0].scatter(*X.T, label="X (n=5)")
ax[0].scatter(*Y.T, marker="x", s=70, label="Y (m=7)")
for i, x in enumerate(X):
    ax[0].annotate(f"x{i}", x, textcoords="offset points", xytext=(4, 4))
for j, y in enumerate(Y):
    ax[0].annotate(f"y{j}", y, textcoords="offset points", xytext=(4, -10))
ax[0].add_patch(plt.Circle((0, 0), 1.0, fill=False, ls="--", color="gray"))
ax[0].set_aspect("equal")
ax[0].legend()
ax[0].set_title("Hai tập điểm (nét đứt: đường tròn đơn vị)")
im = ax[1].imshow(D, cmap="viridis")
ax[1].set_title("D[i, j] = ||x_i − y_j||² (bài trước)")
ax[1].set_xlabel("j (điểm của Y)")
ax[1].set_ylabel("i (điểm của X)")
fig.colorbar(im, ax=ax[1])
plt.tight_layout()
plt.show()
