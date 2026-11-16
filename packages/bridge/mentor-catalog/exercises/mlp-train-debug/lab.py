# %% [markdown]
# Dữ liệu XOR: hai cụm lớp 0 ở góc (−,−) và (+,+), hai cụm lớp 1 ở (−,+) và (+,−). Một đường thẳng không tách được, MLP một lớp ẩn thì được.

# %%
import numpy as np
import matplotlib.pyplot as plt

def make_xor(n=400, seed=0, noise=0.35):
    rng = np.random.default_rng(seed)
    centers = np.array([[-1, -1], [1, 1], [-1, 1], [1, -1]], dtype=float)
    labels = np.array([0, 0, 1, 1])
    idx = rng.integers(0, 4, size=n)
    return centers[idx] + rng.normal(scale=noise, size=(n, 2)), labels[idx]

X, y = make_xor()
plt.figure(figsize=(4, 4))
plt.scatter(*X.T, c=y, cmap="coolwarm", s=10)
plt.title("XOR")
plt.show()

# %%
def plot_boundary(predict_fn, X, y):
    """Vẽ vùng quyết định của mô hình: gọi plot_boundary(lambda Z: predict(params, Z), X, y)."""
    xs, ys = np.meshgrid(np.linspace(-2.5, 2.5, 200), np.linspace(-2.5, 2.5, 200))
    Z = predict_fn(np.c_[xs.ravel(), ys.ravel()]).reshape(xs.shape)
    plt.figure(figsize=(4, 4))
    plt.contourf(xs, ys, Z, alpha=0.3, cmap="coolwarm")
    plt.scatter(*X.T, c=y, cmap="coolwarm", s=10)
    plt.show()
