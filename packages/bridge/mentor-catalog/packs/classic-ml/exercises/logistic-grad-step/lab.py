# %% [markdown]
# # Ổn định số của softplus $\log(1 + e^z)$ và sigmoid $\sigma(z)$
# Viết ngây thơ `np.log(1 + np.exp(z))` sẽ tràn thành `inf` từ $z > 710$, còn `np.logaddexp(0, z)` chính xác và hữu hạn với mọi $z$.

# %%
import numpy as np
import matplotlib.pyplot as plt

z = np.linspace(-8, 8, 200)
sp = np.logaddexp(0.0, z)
sig = np.where(z >= 0, 1.0 / (1.0 + np.exp(-np.minimum(z, 500))), np.exp(np.maximum(z, -500)) / (1.0 + np.exp(np.maximum(z, -500))))

fig, ax = plt.subplots(1, 2, figsize=(8, 3))
ax[0].plot(z, sp, label="softplus(z) = log(1 + e^z)")
ax[0].plot(z, np.maximum(0, z), "--", label="ReLU(z) (tiệm cận)")
ax[0].legend(); ax[0].set_title("Loss khi y = 0")
ax[1].plot(z, sig, color="teal")
ax[1].set_title("Đạo hàm ∂softplus/∂z = σ(z)")
plt.tight_layout()
plt.show()
