# %% [markdown]
# # Lần theo log-sum-exp và entropy theo nhiệt độ τ
# Quan sát cách phân bố $P$ và đại lượng $H$ biến đổi khi nhiệt độ $\tau$ tăng từ rất nhỏ đến rất lớn.

# %%
import numpy as np
import matplotlib.pyplot as plt

Z = np.array([[2.0, 0.5, -1.0, 0.0]])
taus = np.logspace(-1, 1.5, 40)
hs = [float(mystery_block_b(Z, tau)[3][0]) for tau in taus]

plt.figure(figsize=(5.5, 3))
plt.semilogx(taus, hs, label="H(τ)")
plt.axhline(np.log(Z.shape[1]), ls="--", color="gray", label=f"ln(K) = ln({Z.shape[1]}) ≈ {np.log(Z.shape[1]):.3f}")
plt.xlabel("Nhiệt độ τ")
plt.ylabel("H")
plt.title("Biến thiên của H theo nhiệt độ τ")
plt.legend()
plt.tight_layout()
plt.show()
