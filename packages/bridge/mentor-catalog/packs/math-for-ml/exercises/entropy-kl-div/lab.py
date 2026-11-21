# %% [markdown]
# # Trực giác về Entropy và tính bất đối xứng của KL divergence
# Xét hai phân bố Bernoulli $p = (a, 1-a)$ và $q = (0.2, 0.8)$ khi $a$ chạy trên $[0, 1]$.

# %%
import numpy as np
import matplotlib.pyplot as plt

a = np.linspace(1e-4, 1 - 1e-4, 200)
q0 = 0.2
H = -(a * np.log(a) + (1 - a) * np.log(1 - a))
kl_pq = a * np.log(a / q0) + (1 - a) * np.log((1 - a) / (1 - q0))
kl_qp = q0 * np.log(q0 / a) + (1 - q0) * np.log((1 - q0) / (1 - a))

fig, ax = plt.subplots(1, 2, figsize=(8, 3))
ax[0].plot(a, H)
ax[0].set_title("Entropy H(Bernoulli(a))")
ax[0].set_xlabel("a")
ax[1].plot(a, kl_pq, label="KL(p || q)")
ax[1].plot(a, kl_qp, "--", label="KL(q || p)")
ax[1].set_ylim(0, 3)
ax[1].set_title("Bất đối xứng của KL với q=(0.2, 0.8)")
ax[1].set_xlabel("a")
ax[1].legend()
plt.tight_layout()
plt.show()
