# %% [markdown]
# # Chẩn đoán triệu chứng: nhân mask SAU softmax
# Với causal mask tam giác dưới cỡ $T=5$, hàng đầu tiên chỉ được phép nhìn token 0 nên trọng số ở vị trí $(0, 0)$ **phải đúng bằng 1.0**.

# %%
import numpy as np
import matplotlib.pyplot as plt

T = 5
scores = np.zeros((T, T))
w_before_mask = np.exp(scores) / np.exp(scores).sum(axis=-1, keepdims=True)
causal = np.tril(np.ones((T, T), dtype=bool))
w_buggy = w_before_mask * causal

fig, ax = plt.subplots(1, 2, figsize=(7, 3))
ax[0].imshow(w_buggy, vmin=0, vmax=1)
ax[0].set_title("Trọng số khi nhân mask SAU softmax")
ax[1].bar(np.arange(T), w_buggy.sum(axis=-1))
ax[1].axhline(1.0, ls="--", color="red", label="Tổng kỳ vọng = 1")
ax[1].set_xlabel("Vị trí query t")
ax[1].set_title("Tổng trọng số mỗi hàng")
ax[1].legend()
plt.tight_layout()
plt.show()
