# %% [markdown]
# **GAE là một "chùm" sai số TD với trọng số giảm dần.** Mỗi bước có sai số TD $\delta_t$ (thưởng thật cộng ước lượng của mạng giá trị, trừ ước lượng hiện tại). GAE cho advantage của bước $t$ là tổng của $\delta_t, \delta_{t+1}, \delta_{t+2}, \dots$ trong đó $\delta_{t+k}$ nhân với $(\gamma\lambda)^k$. Hình trái vẽ các trọng số đó với $\gamma = 0.99$. Quan sát: $\lambda = 0$ chỉ giữ $\delta_t$ (độ cao 1 ở $k = 0$, rồi 0); $\lambda = 1$ giữ gần như mọi $\delta$ tương lai. Tầm nhìn xa hiệu dụng là $1/(1-\gamma\lambda)$ bước.
#
# **Bias và phương sai.** Hình phải: (cam) khi mạng giá trị $V$ ước lượng sai, phần lỗi của $V$ lọt vào advantage với tổng trọng số $\gamma(1-\lambda)/(1-\gamma\lambda)$ (đó là **bias**, lớn khi $\lambda$ nhỏ); (xanh) nếu mỗi bước thưởng nhiễu độc lập với phương sai 1 thì phương sai của advantage tỉ lệ $1/(1-\gamma^2\lambda^2)$ (đó là **phương sai**, lớn khi $\lambda$ lớn). Trước khi code, đoán: ở $\lambda = 0.95$, phương sai gấp bao nhiêu lần so với $\lambda = 0$, và bias bằng khoảng bao nhiêu phần của mức tối đa? Vì sao người ta hay chọn $\lambda$ ở giữa?

# %%
import numpy as np
import matplotlib.pyplot as plt

gamma = 0.99
k = np.arange(0, 61)
lams = [0.0, 0.5, 0.9, 0.95, 1.0]

fig, axes = plt.subplots(1, 2, figsize=(10, 3.8))
for lam in lams:
    axes[0].plot(k, (gamma * lam) ** k, label=f"lambda = {lam}")
axes[0].set_xlabel("k: delta_(t+k) nằm sau bước t bao nhiêu bước")
axes[0].set_ylabel("trọng số (gamma * lambda)^k")
axes[0].legend()

grid = np.linspace(0, 1, 201)
variance = 1.0 / (1.0 - (gamma * grid) ** 2)
bias = gamma * (1.0 - grid) / (1.0 - gamma * grid)
axes[1].plot(grid, variance / variance[0], color="tab:blue")
axes[1].set_xlabel("lambda")
axes[1].set_ylabel("phương sai (lần so với lambda = 0)", color="tab:blue")
twin = axes[1].twinx()
twin.plot(grid, bias, color="tab:orange")
twin.set_ylabel("tổng trọng số của lỗi V (bias)", color="tab:orange")
plt.tight_layout()
plt.show()

i = int(np.argmin(np.abs(grid - 0.95)))
print(f"lambda = 0.95: phương sai gấp {variance[i] / variance[0]:.1f} lần lambda = 0, bias còn {bias[i] / bias[0]:.0%} mức của lambda = 0")

# %% [markdown]
# **Ranh giới episode.** Một rollout 12 bước gồm hai episode (bước 0-6 và 7-11; `done` ở bước 6, và rollout cắt ngang ở bước 11 mà chưa done). Hình dưới tô màu ô $(t, s)$ nếu $\delta_s$ **được phép** đóng góp vào $A_t$: cùng episode và $s \ge t$. Ô xám là phần bị chặn. Câu hỏi: ở cuối rollout (đường đứt), $\delta_{11}$ nhìn vào trạng thái nào để bootstrap, vì sao cần `last_value`, và ở bước 6 (done) thì sao?

# %%
T = 12
t_idx = np.arange(T)
episode = np.where(t_idx <= 6, 0, 1)
allowed = (t_idx[None, :] >= t_idx[:, None]) & (episode[:, None] == episode[None, :])

fig, ax = plt.subplots(figsize=(5.4, 4.6))
ax.imshow(allowed.astype(float), cmap="Greens", vmin=0, vmax=1.4)
ax.axhline(6.5, color="red", lw=1)
ax.axvline(6.5, color="red", lw=1)
ax.axvline(11.5, color="black", lw=1.5, ls="--")
ax.set_xlabel("s: sai số TD delta_s")
ax.set_ylabel("t: advantage A_t")
ax.set_title("delta_s nào được phép dính vào A_t")
ax.set_xticks(range(T))
ax.set_yticks(range(T))
plt.tight_layout()
plt.show()
