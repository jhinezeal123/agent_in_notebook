# %% [markdown]
# # Lần theo cấu trúc ma trận trọng số trong causal attention
# Khi điểm $Q K^\top$ bằng 0 ở mọi cặp, softmax sau causal mask tạo ra một cấu trúc trọng số rất đặc trưng theo từng dòng $t$.

# %%
import numpy as np
import matplotlib.pyplot as plt

B, T, D, d = 1, 6, 4, 8
X = np.ones((B, T, D))
Wq = np.zeros((D, d))
Wk = np.zeros((D, d))
Wv = np.eye(D, d)
Q, S, A, Y = mystery_block_c(X, Wq, Wk, Wv)

fig, ax = plt.subplots(figsize=(4.5, 3.5))
im = ax.imshow(A[0], vmin=0, vmax=1, cmap="viridis")
plt.colorbar(im, ax=ax)
ax.set_xlabel("Vị trí key j")
ax.set_ylabel("Vị trí query i")
ax.set_title("Ma trận trọng số A[0] khi Wq = 0")
plt.tight_layout()
plt.show()
