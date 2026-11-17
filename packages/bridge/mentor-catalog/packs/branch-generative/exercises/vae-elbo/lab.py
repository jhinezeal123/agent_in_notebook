# %% [markdown]
# **ELBO có hai hạng kéo ngược nhau.** Loss của VAE là "tái tạo" (decoder phải dựng lại $x$ từ $z$) cộng "KL" (encoder không được trôi xa prior). Hai hạng này phải cùng **đơn vị**, nếu không một hạng nuốt hạng kia. Hình dưới lấy số liệu điển hình của một VAE trên ảnh $28\times28$ (784 pixel) cỡ vài epoch: tái tạo khoảng 100 nat mỗi ảnh (cỡ 0.13 nat mỗi pixel) và KL khoảng 25 nat mỗi ảnh. Nhìn hai cột: nếu tái tạo được **cộng theo pixel** thì hai hạng cùng cỡ; nếu bị **trung bình theo pixel** (mặc định `reduction="mean"` của nhiều hàm loss) thì tái tạo chỉ còn 0.13, bằng một phần nghìn KL. Trục dùng thang log.

# %%
import numpy as np
import matplotlib.pyplot as plt

recon_per_image, kl_per_image, pixels = 100.0, 25.0, 784
fig, ax = plt.subplots(figsize=(6.4, 3.4))
labels = ["tái tạo cộng theo pixel", "tái tạo trung bình theo pixel"]
recon = [recon_per_image, recon_per_image / pixels]
x = np.arange(2)
ax.bar(x - 0.18, recon, width=0.36, label="tái tạo")
ax.bar(x + 0.18, [kl_per_image] * 2, width=0.36, label="KL (cộng theo chiều latent)")
ax.set_yscale("log")
ax.set_xticks(x)
ax.set_xticklabels(labels)
ax.set_ylabel("đóng góp vào loss của một ảnh (nat, thang log)")
ax.legend(fontsize=8)
for xi, r in zip(x, recon):
    ax.text(xi - 0.18, r * 1.15, f"{r:.2f}", ha="center", fontsize=8)
ax.text(x[1] + 0.18, kl_per_image * 1.15, f"{kl_per_image:.0f}", ha="center", fontsize=8)
plt.tight_layout()
plt.show()

# %% [markdown]
# **Điều gì xảy ra khi KL lấn át?** Thu bài toán về một chiều latent và một "ảnh" chỉ có một con số cần tái tạo $c=2$. Encoder chọn $q=\mathcal N(m, s^2)$ và decoder tái tạo $\hat x=z$, nên tái tạo kỳ vọng là $w\big[(m-2)^2+s^2\big]$, trong đó $w$ là **trọng số của tái tạo so với KL** (lớn khi tái tạo được cộng theo pixel, nhỏ khi bị trung bình, và cũng tương đương $1/\beta$). KL của $q$ so với $\mathcal N(0,1)$ cộng vào. Nghiệm tối ưu (giải được bằng tay) là $m^*=\dfrac{4w}{2w+1}$ và $s^{*2}=\dfrac{1}{2w+1}$. Hình vẽ chúng theo $w$ (trục log). Nhìn bên trái hình: khi $w$ rất nhỏ thì $q$ làm gì? Encoder còn mang thông tin về $x$ (ở đây $c=2$) không? Đây là **posterior collapse**, và là lý do loss phải có đúng quy ước tổng/trung bình.

# %%
w = np.logspace(-3, 3, 200)
m_star = 4 * w / (2 * w + 1)
s_star = np.sqrt(1 / (2 * w + 1))
fig, ax = plt.subplots(1, 2, figsize=(9, 3.2))
ax[0].plot(w, m_star, label="m* (trung bình của q)")
ax[0].axhline(2, color="gray", ls=":", label="giá trị cần tái tạo c = 2")
ax[0].set_xscale("log")
ax[0].set_xlabel("trọng số tái tạo w (1/β)")
ax[0].legend(fontsize=8)
ax[1].plot(w, s_star, color="tab:orange", label="s* (độ lệch chuẩn của q)")
ax[1].axhline(1, color="gray", ls=":", label="s = 1 (prior)")
ax[1].set_xscale("log")
ax[1].set_xlabel("trọng số tái tạo w (1/β)")
ax[1].legend(fontsize=8)
plt.tight_layout()
plt.show()

# %% [markdown]
# **Tại sao nên tính BCE từ logits.** Với một pixel có nhãn $x=1$, BCE là $-\log\sigma(\ell)$. Cách "ngây thơ" là tính $\sigma(\ell)$ trước rồi lấy $\log$. Hình dưới so sánh cách đó, tính bằng **float32** (kiểu số mặc định của PyTorch), với giá trị thật tính bằng float64. Tìm điểm mà đường float32 đứt hoặc lệch: khi logit rất âm (decoder rất tự tin pixel là 0 nhưng nhãn là 1) thì chuyện gì xảy ra với loss và với gradient? Một hàm loss tốt phải đưa ra con số hữu hạn ngay cả ở đó.

# %%
ell = np.linspace(-120, 20, 500)
truth = np.log1p(np.exp(-ell.astype(np.float64)))
with np.errstate(all="ignore"):
    e32 = ell.astype(np.float32)
    naive = -np.log(np.float32(1) / (np.float32(1) + np.exp(-e32)))
fig, ax = plt.subplots(figsize=(6, 3.2))
ax.plot(ell, truth, label="giá trị thật (float64)", lw=3, alpha=0.4)
ax.plot(ell, naive, "--", label="sigmoid rồi log, float32")
ax.set_ylim(-5, 130)
ax.set_xlabel("logit ℓ (nhãn x = 1)")
ax.set_ylabel("BCE của một pixel")
ax.legend(fontsize=8)
plt.tight_layout()
plt.show()
