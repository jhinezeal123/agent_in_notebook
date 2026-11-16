# %% [markdown]
# Mỗi vị trí $(b, t)$ cần **nhặt đúng một số** trong $V$ số: $\log p_{b,t,y_{bt}}$. Rồi lấy trung bình *chỉ trên token thật*.
#
# Hai câu hỏi trước khi code: (1) nhặt theo chỉ số nằm trong một mảng khác thì dùng gì? (2) chia cho cái gì?

# %%
import numpy as np
import matplotlib.pyplot as plt

rng = np.random.default_rng(0)
B, T, V = 3, 6, 5
lengths = np.array([6, 4, 2])
mask = np.arange(T)[None, :] < lengths[:, None]
logits = rng.normal(size=(B, T, V))
log_probs = logits - np.log(np.exp(logits).sum(-1, keepdims=True))
targets = rng.integers(0, V, size=(B, T))
print("mask:\n", mask.astype(int))
print("targets:\n", targets)

# %%
fig, ax = plt.subplots(1, 3, figsize=(12, 3))
ax[0].imshow(mask, cmap="Greys", vmin=0, vmax=1)
ax[0].set_title("mask (đen = token thật)")
ax[1].imshow(log_probs[0].T, cmap="magma")
ax[1].scatter(np.arange(T), targets[0], c="cyan", marker="o", label="nhãn đúng")
ax[1].set_title("log_probs[0] (trục dọc = từ vựng)")
ax[1].set_xlabel("t")
ax[1].legend(loc="upper right", fontsize=7)
ax[2].bar(range(B), lengths)
ax[2].set_title("số token thật mỗi câu")
plt.tight_layout()
plt.show()
