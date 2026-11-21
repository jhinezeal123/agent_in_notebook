# %% [markdown]
# # Trực giác: hậu nghiệm co lại theo số mẫu $n$, nhưng phương sai tiên đoán bị chặn dưới bởi nhiễu quan sát $\sigma^2$

# %%
import numpy as np
import matplotlib.pyplot as plt

mu0, var0, obs_var = 0.0, 4.0, 1.0
ns = np.arange(0, 41)
var_post = 1.0 / (1.0 / var0 + ns / obs_var)
var_pred = var_post + obs_var

plt.figure(figsize=(5.5, 3))
plt.plot(ns, var_post, label="Phương sai hậu nghiệm Var(θ | x)")
plt.plot(ns, var_pred, "--", label="Phương sai tiên đoán Var(x_new | x)")
plt.axhline(obs_var, ls=":", color="gray", label="Nhiễu quan sát σ² (không thể khử)")
plt.xlabel("Số quan sát n")
plt.ylabel("Phương sai")
plt.legend()
plt.tight_layout()
plt.show()
