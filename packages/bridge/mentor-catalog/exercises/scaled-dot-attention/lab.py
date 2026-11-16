# %% [markdown]
# $$\operatorname{Attention}(Q, K, V) = \operatorname{softmax}\!\left(\frac{QK^\top}{\sqrt{d_k}}\right) V$$
#
# Thí nghiệm dưới đây cho thấy chuyện gì xảy ra với softmax khi $d_k$ lớn, có và không có phép chia.

# %%
import numpy as np
import matplotlib.pyplot as plt

rng = np.random.default_rng(0)
ds = [4, 16, 64, 256]

def softmax(x):
    x = x - x.max(-1, keepdims=True)
    e = np.exp(x)
    return e / e.sum(-1, keepdims=True)

fig, axes = plt.subplots(2, len(ds), figsize=(12, 5.5))
for i, d in enumerate(ds):
    q = rng.normal(size=(8, d))
    k = rng.normal(size=(8, d))
    s = q @ k.T
    axes[0, i].imshow(softmax(s), vmin=0, vmax=1, cmap="viridis")
    axes[0, i].set_title(f"d={d}, không chia")
    axes[1, i].imshow(softmax(s / np.sqrt(d)), vmin=0, vmax=1, cmap="viridis")
    axes[1, i].set_title(f"d={d}, chia √d")
plt.tight_layout()
plt.show()

# %%
spread = [float((rng.normal(size=(4000, d)) * rng.normal(size=(4000, d))).sum(1).std()) for d in ds]
plt.figure(figsize=(5, 3))
plt.plot(ds, spread, "o-", label="std của q·k")
plt.plot(ds, np.sqrt(ds), "--", label="√d")
plt.xscale("log", base=2)
plt.xlabel("d")
plt.legend()
plt.title("Độ lớn của q·k khi q, k ~ N(0, I)")
plt.show()

# %%
# Mask nhân quả (causal): token t chỉ được nhìn các vị trí ≤ t.
T = 6
causal = np.tril(np.ones((T, T), dtype=bool))
plt.figure(figsize=(3, 3))
plt.imshow(causal, cmap="Greys")
plt.title("causal mask (đen = được nhìn)")
plt.xlabel("s (key)")
plt.ylabel("t (query)")
plt.show()
