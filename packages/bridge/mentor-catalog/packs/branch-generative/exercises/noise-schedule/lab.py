# %% [markdown]
# **Quá trình thuận, đi từng bước.** Mỗi bước của DDPM thu nhỏ ảnh một chút rồi cộng thêm nhiễu: $x_t=\sqrt{1-\beta_t}\,x_{t-1}+\sqrt{\beta_t}\,\varepsilon$ với $\varepsilon\sim\mathcal N(0,1)$ (Eq. 2 của paper). Để thấy "tín hiệu" còn lại bao nhiêu theo thời gian, ta chạy chuỗi này thật, từng bước một, trên 20000 "ảnh một pixel" mà mọi $x_0$ đều bằng 1, rồi đo **trung bình** (phần tín hiệu của ảnh gốc còn sót) và **độ lệch chuẩn** (độ lớn của nhiễu đã tích luỹ) của $x_t$ qua $T=1000$ bước với $\beta$ tăng tuyến tính từ $10^{-4}$ đến $0.02$.
#
# Đọc hình bên trái: ở cuối chuỗi, trung bình và độ lệch chuẩn là bao nhiêu? Đọc hình bên phải (trục dọc log): khi nào tín hiệu chỉ còn một nửa, gần đầu, giữa hay cuối chuỗi? Bạn có đoán đúng không?

# %%
import numpy as np
import matplotlib.pyplot as plt

T = 1000
beta = np.linspace(1e-4, 0.02, T)
rng = np.random.default_rng(0)
x = np.ones(20000)
mean, std = [], []
for b in beta:
    x = np.sqrt(1 - b) * x + np.sqrt(b) * rng.standard_normal(x.shape)
    mean.append(x.mean())
    std.append(x.std())
mean, std = np.array(mean), np.array(std)
half = int(np.argmax(mean < 0.5))
print(f"trung bình < 0.5 lần đầu ở chỉ số {half} (trên tổng T = {T}); cuối chuỗi: trung bình {mean[-1]:.3f}, độ lệch chuẩn {std[-1]:.3f}")

fig, ax = plt.subplots(1, 2, figsize=(9.5, 3.4))
ax[0].plot(mean, label="trung bình của x_t (tín hiệu)")
ax[0].plot(std, label="độ lệch chuẩn của x_t (nhiễu)")
ax[0].set_xlabel("chỉ số bước (từ 0)")
ax[0].legend(fontsize=8)
ax[1].semilogy(np.maximum(mean, 1e-3))
ax[1].axvline(half, color="r", lw=0.8, ls=":")
ax[1].axhline(0.5, color="gray", lw=0.6)
ax[1].set_xlabel("chỉ số bước (từ 0)")
ax[1].set_ylabel("trung bình của x_t (log)")
plt.tight_layout()
plt.show()

# %% [markdown]
# **Lịch β trông thế nào.** Hình dưới vẽ $\beta_t$ (mức nhiễu thêm vào ở mỗi bước) và $1-\beta_t$ (hệ số mà bước đó nhân vào tín hiệu). Mỗi bước chỉ làm mất một phần rất nhỏ tín hiệu, vậy mà qua cả chuỗi tín hiệu biến mất gần hết. Từ hình, hãy tự hỏi: để biết tín hiệu còn lại sau $t$ bước, ta phải gộp $t$ con số $1-\beta_s$ bằng phép gì? Cộng hay nhân? Trục thời gian của phép gộp đó là trục nào của mảng độ dài $T$?

# %%
fig, ax = plt.subplots(1, 2, figsize=(9.5, 3.0))
ax[0].plot(beta)
ax[0].set_ylabel("β (nhiễu thêm mỗi bước)")
ax[1].plot(1 - beta, color="tab:green")
ax[1].set_ylabel("1 − β (hệ số nhân lên tín hiệu)")
for a in ax:
    a.set_xlabel("chỉ số bước (từ 0)")
plt.tight_layout()
plt.show()
