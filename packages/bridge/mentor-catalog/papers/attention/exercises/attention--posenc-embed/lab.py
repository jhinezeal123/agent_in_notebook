# %% [markdown]
# **Mỗi cặp cột là một sóng, và các sóng có chu kỳ trải rất rộng (§3.5).** Hình trái: sóng $\sin(\text{pos}/10000^{2i/d_\text{model}})$ của vài chỉ số cặp cột $i$ với $d_\text{model}=64$. Cột đầu ($i=0$) đổi rất nhanh theo vị trí, cột cuối gần như phẳng trên 64 vị trí đầu. Giống một bộ đếm: chữ số hàng đơn vị nhảy liên tục, chữ số hàng nghìn gần như đứng yên; ghép lại thì mỗi vị trí có một "mã" riêng.
#
# Hình phải: vì sao phải nhân embedding với $\sqrt{d_\text{model}}$. Embedding khởi tạo với độ lệch chuẩn $d_\text{model}^{-1/2}$ rất nhỏ so với sóng sin/cos (biên độ 1); nhân $\sqrt{d_\text{model}}$ đưa nó về cỡ 1, cân với PE.

# %%
import numpy as np
import matplotlib.pyplot as plt

d = 64
pos = np.arange(64)
fig, ax = plt.subplots(1, 2, figsize=(10, 3.2))
for i in [0, 4, 16, 31]:
    ax[0].plot(pos, np.sin(pos / 10000 ** (2 * i / d)), label=f"i = {i}")
ax[0].set_xlabel("vị trí pos"); ax[0].set_ylabel("sin(...)"); ax[0].legend(fontsize=8)

rng = np.random.default_rng(0)
small = rng.normal(0, d ** -0.5, 5000)           # embedding lúc khởi tạo
ax[1].hist(small, bins=60, alpha=0.6, density=True, label="embedding (std = d^-1/2)")
ax[1].hist(small * d ** 0.5, bins=60, alpha=0.6, density=True, label="sau khi nhân √d_model")
ax[1].axvline(-1, color="k", ls="--")
ax[1].axvline(1, color="k", ls="--", label="biên độ sin/cos")
ax[1].set_xlim(-4, 4); ax[1].legend(fontsize=8)
plt.tight_layout()
plt.show()
