# %% [markdown]
# # Chẩn đoán triệu chứng: sai số khi phương sai tiến về 0
# Quan sát tỉ số giữa $\sqrt{\sigma^2 + \varepsilon}$ và $\sqrt{\sigma^2} + \varepsilon$ khi $\sigma^2$ nhỏ dần.

# %%
import numpy as np
import matplotlib.pyplot as plt

eps = 1e-3
var = np.logspace(-6, 0, 100)
in_sqrt = np.sqrt(var + eps)
out_sqrt = np.sqrt(var) + eps

plt.figure(figsize=(5.5, 3))
plt.semilogx(var, out_sqrt / in_sqrt)
plt.axhline(1.0, ls="--", color="gray")
plt.xlabel("Phương sai σ²")
plt.ylabel("Tỉ số (√σ² + ε) / √(σ² + ε)")
plt.title("Độ lệch mẫu số khi phương sai nhỏ")
plt.tight_layout()
plt.show()
