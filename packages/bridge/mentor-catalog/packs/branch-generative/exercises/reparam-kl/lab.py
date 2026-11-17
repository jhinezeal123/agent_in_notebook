# %% [markdown]
# **KL là "khoảng cách" từ encoder tới prior, nhìn bằng mắt.** Encoder của VAE nhả ra $\mu$ và $\text{logvar}=\log\sigma^2$ cho mỗi chiều latent, tức một Gaussian $\mathcal N(\mu,\sigma^2)$. Loss muốn nó không trôi quá xa prior $\mathcal N(0,1)$. Hình dưới vẽ bốn encoder khác nhau (đường đặc) cạnh prior (đường đứt); tiêu đề ghi $D_{\mathrm{KL}}\big(\mathcal N(\mu,\sigma^2)\,\|\,\mathcal N(0,1)\big)$ được **tính bằng tích phân số** (cộng $p\log(p/q)$ trên lưới điểm), không phải bằng công thức đóng bạn sắp viết. Hãy nhìn: KL tăng khi lệch tâm (đổi $\mu$) hay khi đổi độ rộng (đổi $\text{logvar}$); và đổi độ rộng theo **hai phía** (hẹp hơn hoặc rộng hơn prior) đều làm KL dương.

# %%
import numpy as np
import matplotlib.pyplot as plt

z = np.linspace(-25, 25, 20001)
dz = z[1] - z[0]


def log_density(z, mu, logvar):
    return -0.5 * np.log(2 * np.pi) - 0.5 * logvar - (z - mu) ** 2 / (2 * np.exp(logvar))


def kl_numeric(mu, logvar):
    p_log, q_log = log_density(z, mu, logvar), log_density(z, 0.0, 0.0)
    return float(np.sum(np.exp(p_log) * (p_log - q_log)) * dz)


cases = [(0.0, 0.0), (1.5, 0.0), (0.0, -2.0), (0.0, 1.5)]
fig, ax = plt.subplots(1, 4, figsize=(12, 2.8), sharey=True)
zz = np.linspace(-6, 6, 400)
for a, (mu, lv) in zip(ax, cases):
    a.plot(zz, np.exp(log_density(zz, 0.0, 0.0)), "k--", lw=1, label="prior N(0, 1)")
    a.plot(zz, np.exp(log_density(zz, mu, lv)), lw=2, label="encoder")
    a.set_title(f"mu = {mu}, logvar = {lv}\nKL ≈ {kl_numeric(mu, lv):.3f}", fontsize=9)
    a.set_xlabel("z")
ax[0].set_ylabel("mật độ")
ax[0].legend(fontsize=7)
plt.tight_layout()
plt.show()

# %% [markdown]
# **KL như một mặt địa hình.** Với một chiều latent, KL là hàm của hai số $(\mu,\ \text{logvar})$. Hình dưới là bản đồ đường mức của nó (cũng tính bằng tích phân số). Trả lời trước khi code: (1) giá trị nhỏ nhất bao nhiêu và ở đâu? (2) mặt này có đối xứng khi đổi $\mu\to-\mu$ không? còn khi đổi $\text{logvar}\to-\text{logvar}$? (3) đi từ $(0,0)$ sang phải trên trục $\text{logvar}$ và sang trái cùng một quãng, phía nào dốc hơn, và gradient theo $\text{logvar}$ ở $(0,0)$ bằng bao nhiêu?

# %%
mus = np.linspace(-2, 2, 41)
lvs = np.linspace(-3, 2, 41)
zs = np.linspace(-30, 30, 4001)
dzs = zs[1] - zs[0]
M, L = np.meshgrid(mus, lvs)
p_log = log_density(zs[None, None, :], M[..., None], L[..., None])
q_log = log_density(zs, 0.0, 0.0)
KL = np.sum(np.exp(p_log) * (p_log - q_log), axis=-1) * dzs

fig, ax = plt.subplots(figsize=(4.8, 4.0))
cs = ax.contourf(M, L, KL, levels=np.linspace(0, 6, 25), cmap="viridis", extend="max")
ax.plot([0], [0], "r*", ms=12, label="mu = 0, logvar = 0")
plt.colorbar(cs, ax=ax, label="KL (nat)")
ax.set_xlabel("mu")
ax.set_ylabel("logvar")
ax.legend(fontsize=7, loc="upper left")
plt.tight_layout()
plt.show()

# %% [markdown]
# **Vì sao phải tách noise ra (reparameterization)?** Cái ta cần là gradient của một kỳ vọng $\nabla_\mu\,\mathbb E_{z\sim\mathcal N(\mu,\sigma^2)}[f(z)]$. Thử với $f(z)=z^2$, $\mu=1$, $\sigma=1$: đáp án đúng là $2\mu=2$. Có hai cách ước lượng từ **10 mẫu** mỗi lần: (a) **score function** (REINFORCE) $\ \overline{f(z)\,(z-\mu)/\sigma^2}$, chỉ cần giá trị $f$ chứ không cần đạo hàm $f$; (b) **pathwise** (reparameterization): viết $z$ là hàm của $\mu$ và một noise $\varepsilon$ không phụ thuộc tham số, rồi đạo hàm xuyên qua $f$. Hình dưới chạy mỗi cách 2000 lần và vẽ phân phối ước lượng. Cả hai đều đúng "trung bình"; nhìn độ rộng của chúng. Đây là lý do VAE dùng cách (b), và lý do code của bạn phải giữ đường gradient nối được từ $z$ về $\mu$ và $\sigma$.

# %%
rng = np.random.default_rng(0)
mu0, sigma0, n, runs = 1.0, 1.0, 10, 2000
score, path = [], []
for _ in range(runs):
    eps = rng.standard_normal(n)
    zs_ = mu0 + sigma0 * eps
    score.append(np.mean(zs_ ** 2 * (zs_ - mu0) / sigma0 ** 2))
    path.append(np.mean(2 * zs_))

fig, ax = plt.subplots(figsize=(6, 3))
bins = np.linspace(-3, 8, 70)
ax.hist(score, bins=bins, alpha=0.6, label=f"score function: std = {np.std(score):.2f}")
ax.hist(path, bins=bins, alpha=0.6, label=f"pathwise (reparam): std = {np.std(path):.2f}")
ax.axvline(2 * mu0, color="k", ls="--", lw=1, label="đáp án đúng = 2")
ax.set_xlabel("ước lượng gradient theo mu từ 10 mẫu")
ax.legend(fontsize=8)
plt.tight_layout()
plt.show()

# %% [markdown]
# **Một bẫy ký hiệu.** Encoder thường xuất ra `logvar` chứ không xuất $\sigma$: vì $\log\sigma^2$ nhận mọi giá trị thực (không cần ép dương), và $\exp$ của nó luôn dương. Hãy tự hỏi: `logvar = -4` ứng với độ lệch chuẩn bao nhiêu? `logvar = 0` thì sao? Và nếu bạn nhầm `logvar` với $\sigma$ hoặc quên hệ số $\tfrac12$, hình ở trên sẽ lệch đi bao nhiêu?
