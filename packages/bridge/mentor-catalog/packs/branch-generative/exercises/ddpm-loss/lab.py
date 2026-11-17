# %% [markdown]
# **Đoán nhiễu khó ở bước nào?** Mô hình của DDPM nhận $x_t$ và phải đoán nhiễu $\varepsilon$ đã thêm vào. Để thấy độ khó của việc đó thay đổi theo $t$, ta dùng một "ảnh một pixel" đơn giản nhất: $x_0\sim\mathcal N(0,1)$, rồi nhiễu nó theo Eq. 4, $x_t=\sqrt{\bar\alpha_t}\,x_0+\sqrt{1-\bar\alpha_t}\,\varepsilon$, với lịch tuyến tính $T=1000$. Hình đo sai số bình phương trung bình của ba cách đoán $\varepsilon$ khi chỉ nhìn $x_t$: (a) luôn đoán 0, (b) đoán $\hat\varepsilon=x_t$, (c) đoán $\hat\varepsilon=\sqrt{1-\bar\alpha_t}\,x_t$ (một hàm tuyến tính của $x_t$, tốt nhất có thể với dữ liệu Gauss này).
#
# Đọc hình: đường (c) cao nhất ở đâu và thấp nhất ở đâu? Ở bước nhỏ (ít nhiễu) việc đoán nhiễu dễ hay khó? Vì sao? (Gợi ý: nhìn hình bên phải, nơi $\varepsilon$ được vẽ theo $x_t$ ở ba bước.)

# %%
import numpy as np
import matplotlib.pyplot as plt

T = 1000
beta = np.linspace(1e-4, 0.02, T)
ab = np.cumprod(1 - beta)
rng = np.random.default_rng(0)
n = 4000


def noisy(step):
    x0 = rng.standard_normal(n)
    eps = rng.standard_normal(n)
    return eps, np.sqrt(ab[step]) * x0 + np.sqrt(1 - ab[step]) * eps


steps = np.arange(0, T, 25)
curves = {"(a) đoán 0": [], "(b) đoán x_t": [], "(c) đoán √(1−ᾱ)·x_t": []}
for s in steps:
    eps, xt = noisy(s)
    curves["(a) đoán 0"].append(np.mean(eps**2))
    curves["(b) đoán x_t"].append(np.mean((eps - xt) ** 2))
    curves["(c) đoán √(1−ᾱ)·x_t"].append(np.mean((eps - np.sqrt(1 - ab[s]) * xt) ** 2))

fig, ax = plt.subplots(1, 4, figsize=(14, 3.2), gridspec_kw={"width_ratios": [2.2, 1, 1, 1]})
for name, ys in curves.items():
    ax[0].plot(steps, ys, label=name)
ax[0].set_xlabel("chỉ số bước t (từ 0)")
ax[0].set_ylabel("sai số bình phương trung bình")
ax[0].legend(fontsize=8)
for a, s in zip(ax[1:], [10, 300, 900]):
    eps, xt = noisy(s)
    a.scatter(xt[:500], eps[:500], s=4, alpha=0.5)
    a.set_title(f"t = {s}", fontsize=9)
    a.set_xlabel("x_t")
    a.set_ylabel("ε")
plt.tight_layout()
plt.show()

# %% [markdown]
# **Biết nhiễu thì biết ảnh sạch.** Eq. 4 là một phương trình hai ẩn $x_0$, $\varepsilon$ khi đã biết $x_t$ và $t$: nếu mô hình đoán được $\varepsilon$ thì tính ngược ra được $x_0$. Hình dưới cho thấy hệ số khuếch đại sai số khi tính ngược này, $\sqrt{1-\bar\alpha_t}\,/\,\sqrt{\bar\alpha_t}$, theo $t$ (trục log). Một sai số 0.1 trong dự đoán nhiễu thành sai số bao nhiêu ở ảnh sạch tại $t$ nhỏ, và tại $t$ rất lớn? Điều đó nói gì về việc "đoán nhiễu" ở bước lớn so với "đoán ảnh" ở bước đó?

# %%
amp = np.sqrt(1 - ab) / np.sqrt(ab)
fig, ax = plt.subplots(figsize=(5.2, 3.2))
ax.semilogy(np.arange(T), amp)
ax.set_xlabel("chỉ số bước t (từ 0)")
ax.set_ylabel("hệ số khuếch đại sai số ε thành sai số x₀")
plt.tight_layout()
plt.show()
