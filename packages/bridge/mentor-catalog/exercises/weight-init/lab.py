# %% [markdown]
# **Vì sao khởi tạo quan trọng.** Cho một mạng sâu 30 lớp, mỗi lớp `h = act(h @ W)` với `W` có 256×256 phần tử lấy từ $\mathcal N(0, \sigma^2)$. Ta theo dõi **độ lệch chuẩn của activation** qua từng lớp.
#
# Mỗi phần tử của `h @ W` là tổng của $n$ = fan_in số hạng; phương sai của nó xấp xỉ $n \cdot \sigma^2 \cdot \mathbb E[h^2]$. Nếu hệ số $n\sigma^2$ (sau khi tính cả tác động của activation) lớn hơn 1 thì tín hiệu phình ra theo cấp số nhân, nhỏ hơn 1 thì tắt dần.

# %%
import numpy as np
import matplotlib.pyplot as plt

rng = np.random.default_rng(0)
n, depth = 256, 30
x0 = rng.normal(size=(512, n))

def run(act, sigma):
    h, stds = x0, []
    for _ in range(depth):
        h = act(h @ (rng.normal(size=(n, n)) * sigma))
        stds.append(h.std())
    return stds

relu = lambda z: np.maximum(z, 0)
fig, ax = plt.subplots(1, 2, figsize=(11, 3.6))
for c in [0.5, 1.0, 1.5]:
    ax[0].plot(run(np.tanh, c / np.sqrt(n)), label=f"σ = {c}/√n")
for c in [1.0, np.sqrt(2), 2.0]:
    ax[1].plot(run(relu, c / np.sqrt(n)), label=f"σ = {c:.2f}/√n")
ax[0].set_title("tanh"); ax[1].set_title("ReLU")
for a in ax:
    a.set_yscale("log"); a.set_xlabel("lớp"); a.set_ylabel("std(activation)"); a.legend()
plt.tight_layout()
plt.show()

# %% [markdown]
# Câu hỏi để kể lại cho mentor: với ReLU, hệ số nào giữ std **phẳng**? Vì sao nó khác tanh? (Gợi ý: ReLU làm gì với một nửa số đầu vào, và $\mathbb E[\operatorname{ReLU}(z)^2]$ bằng bao nhiêu phần của $\operatorname{Var}(z)$?)

# %%
# Phân phối activation ở lớp cuối với tanh: quá nhỏ thì dồn về 0, quá lớn thì bão hoà ±1.
fig, ax = plt.subplots(1, 3, figsize=(11, 3), sharey=True)
for a, c in zip(ax, [0.5, 1.0, 3.0]):
    h = x0
    for _ in range(depth):
        h = np.tanh(h @ (rng.normal(size=(n, n)) * c / np.sqrt(n)))
    a.hist(h.ravel(), bins=60, range=(-1, 1), color="tab:purple")
    a.set_title(f"tanh, σ = {c}/√n")
plt.tight_layout()
plt.show()

# %% [markdown]
# **Normal hay uniform?** Đuôi của phân phối chuẩn dài, phân phối đều thì bị chặn cứng. Nhưng **cận** của phân phối đều không phải là độ lệch chuẩn của nó: nhìn số đo dưới đây với $\mathcal U(-1, 1)$. Để phương sai bằng một giá trị cho trước, cận $a$ phải là bao nhiêu? Hãy tự tính $\operatorname{Var}(\mathcal U(-a, a))$ bằng tích phân.

# %%
z = rng.normal(size=200_000)
u = rng.uniform(-1, 1, size=200_000)
fig, ax = plt.subplots(figsize=(6.5, 3))
ax.hist(z, bins=120, range=(-4, 4), density=True, alpha=0.5, label=f"N(0, 1): std đo được {z.std():.3f}")
ax.hist(u, bins=120, range=(-4, 4), density=True, alpha=0.5, label=f"U(-1, 1): std đo được {u.std():.3f}")
ax.set_title(f"N(0, 1) có {np.mean(np.abs(z) > 2):.1%} giá trị ngoài ±2σ; U thì không có")
ax.legend(fontsize=8)
plt.tight_layout()
plt.show()
