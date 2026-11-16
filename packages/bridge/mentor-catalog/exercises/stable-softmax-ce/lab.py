# %% [markdown]
# $$\operatorname{softmax}(z)_i = \frac{e^{z_i}}{\sum_j e^{z_j}}, \qquad \log \operatorname{softmax}(z)_i = z_i - \log \sum_j e^{z_j}$$
#
# Mẹo log-sum-exp: với $m = \max_j z_j$, $\;\log \sum_j e^{z_j} = m + \log \sum_j e^{z_j - m}$.

# %%
import numpy as np
import matplotlib.pyplot as plt

z = np.array([1000.0, 1001.0, 1002.0])
with np.errstate(over="ignore", invalid="ignore"):
    naive = np.exp(z) / np.exp(z).sum()
print("Cách ngây thơ:", naive)
print("Sau khi trừ max:", np.exp(z - z.max()) / np.exp(z - z.max()).sum())

# %%
# Softmax với nhiệt độ: chia logits cho T trước khi softmax.
logits = np.array([2.0, 1.0, 0.2, -1.0])
fig, axes = plt.subplots(1, 3, figsize=(11, 3), sharey=True)
for ax, T in zip(axes, [0.5, 1.0, 3.0]):
    p = np.exp(logits / T - (logits / T).max())
    p /= p.sum()
    ax.bar(range(len(p)), p)
    ax.set_title(f"T = {T}")
    ax.set_xlabel("lớp")
axes[0].set_ylabel("xác suất")
plt.tight_layout()
plt.show()
