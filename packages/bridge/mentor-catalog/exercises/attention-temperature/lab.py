# %% [markdown]
# Nhắc lại bài trước: attention với causal mask, $\tau = 1$. Bên trái là ma trận `weights`, bên phải là **entropy** của từng hàng (đo mức "dàn trải" của hàng đó) so với mức tối đa $\log(t+1)$ khi trọng số chia đều trên $t+1$ vị trí được nhìn.
#
# Trước khi code, hãy đoán: chia điểm cho $\tau$ rất nhỏ hoặc rất lớn thì hai hình này đổi thế nào?

# %%
import numpy as np
import matplotlib.pyplot as plt

rng = np.random.default_rng(0)
T, d = 8, 16
Q, K = rng.normal(size=(T, d)), rng.normal(size=(T, d))
causal = np.tril(np.ones((T, T), dtype=bool))
s = np.where(causal, Q @ K.T / np.sqrt(d), -np.inf)
e = np.exp(s - s.max(axis=1, keepdims=True))
w = e / e.sum(axis=1, keepdims=True)
with np.errstate(divide="ignore", invalid="ignore"):
    ent = -np.where(w > 0, w * np.log(w), 0.0).sum(axis=1)

fig, ax = plt.subplots(1, 2, figsize=(10, 3.4))
im = ax[0].imshow(w, vmin=0, vmax=1, cmap="viridis")
ax[0].set_title("weights, τ = 1 (causal)")
ax[0].set_xlabel("s (key)")
ax[0].set_ylabel("t (query)")
fig.colorbar(im, ax=ax[0])
ax[1].plot(ent, "o-", label="entropy của hàng t")
ax[1].plot(np.log(np.arange(1, T + 1)), "--", label="log(t + 1): chia đều")
ax[1].set_xlabel("t")
ax[1].legend()
ax[1].set_title("Hàng dàn trải đến đâu, τ = 1")
plt.tight_layout()
plt.show()
