# %% [markdown]
# **Ba hạng log trong GAN.** Gọi $D=D(\text{ảnh giả})\in(0,1)$ là xác suất mà discriminator cho rằng một ảnh **giả** là thật. Có ba đại lượng xuất hiện trong bài: $-\log D$ (loss non-saturating của $G$, và cũng là hạng "ảnh thật" của $D$ khi $D$ nhìn ảnh thật), $-\log(1-D)$ (hạng "ảnh giả" của $D$) và $\log(1-D)$ (loss minimax gốc của $G$, là **âm** của hạng ảnh giả của $D$: hai bên chơi trò zero-sum). Hình dưới vẽ ba hàm theo $D$. Nhìn xem: $G$ muốn đẩy $D\to 1$; khi $D\approx 0$ (D rất tự tin ảnh là giả, $G$ đang thua nặng) thì mỗi đường cong **cao hay thấp**, **dốc hay phẳng** ở đó? Chỉ cần so hình dạng, ta sẽ tính gradient theo logit ở bài sau.

# %%
import numpy as np
import matplotlib.pyplot as plt

D = np.linspace(0.002, 0.998, 500)
fig, ax = plt.subplots(figsize=(6.4, 3.6))
ax.plot(D, -np.log(D), label="−log D")
ax.plot(D, -np.log(1 - D), label="−log(1 − D)")
ax.plot(D, np.log(1 - D), label="log(1 − D)")
ax.axhline(0, color="gray", lw=0.6)
ax.set_xlabel("D = xác suất D cho ảnh giả là thật")
ax.set_ylabel("giá trị loss")
ax.set_ylim(-6, 6)
ax.legend(fontsize=8)
plt.tight_layout()
plt.show()

# %% [markdown]
# **Gradient của loss non-saturating theo logit.** $D$ thật ra nhả ra một logit $\ell$ và $D=\sigma(\ell)$, nên gradient mà $G$ nhận đi qua $\ell$. Hình dưới vẽ $-\log\sigma(\ell)$ theo $\ell$ (trái), và độ dốc của nó (phải), tính bằng sai phân hữu hạn (phép đạo hàm số chứ không phải công thức). Đọc hình phải: khi $D$ rất tự tin ảnh là giả ($\ell\ll 0$), gradient bằng khoảng bao nhiêu? Khi $D$ bị lừa ($\ell\gg 0$) thì sao? Đó có phải hành vi ta muốn ở một người chơi đang thua?

# %%
ell = np.linspace(-12, 12, 400)
loss = lambda l: -np.log(1 / (1 + np.exp(-l)))
h = 1e-5
slope = (loss(ell + h) - loss(ell - h)) / (2 * h)
fig, ax = plt.subplots(1, 2, figsize=(9, 3.2))
ax[0].plot(ell, loss(ell))
ax[0].set_xlabel("logit ℓ của ảnh giả")
ax[0].set_ylabel("−log D")
ax[1].plot(ell, slope, color="tab:orange")
ax[1].axhline(0, color="gray", lw=0.6)
ax[1].set_xlabel("logit ℓ của ảnh giả")
ax[1].set_ylabel("d(−log D) / dℓ")
plt.tight_layout()
plt.show()

# %% [markdown]
# **Vì sao đề đòi loss tính từ logits.** Hạng ảnh giả của $D$ là $-\log(1-\sigma(\ell))$. Hình dưới tính nó theo cách "ngây thơ" (sigmoid rồi log) trong **float32** (kiểu số mặc định của PyTorch) và so với giá trị thật tính bằng float64. Tìm điểm mà đường float32 biến mất: logit bằng bao nhiêu thì loss thành `inf`? Một discriminator sau vài trăm bước train có logits lớn cỡ đó là chuyện bình thường, không phải ca hiếm.

# %%
ell = np.linspace(0, 40, 400)
truth = np.log1p(np.exp(ell.astype(np.float64)))
with np.errstate(all="ignore"):
    e32 = ell.astype(np.float32)
    sig = np.float32(1) / (np.float32(1) + np.exp(-e32))
    naive = -np.log(np.float32(1) - sig)
first_bad = ell[~np.isfinite(naive)][0]
fig, ax = plt.subplots(figsize=(6, 3.2))
ax.plot(ell, truth, lw=3, alpha=0.4, label="giá trị thật (float64)")
ax.plot(ell, naive, "--", label="−log(1 − sigmoid(ℓ)), float32")
ax.axvline(first_bad, color="r", lw=0.8, ls=":")
ax.text(first_bad + 0.5, 5, f"inf từ ℓ ≈ {first_bad:.1f}", color="r", fontsize=8)
ax.set_xlabel("logit ℓ của ảnh giả")
ax.set_ylabel("hạng ảnh giả của D")
ax.legend(fontsize=8)
plt.tight_layout()
plt.show()
