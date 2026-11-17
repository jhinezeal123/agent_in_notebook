# %% [markdown]
# **Đường thẳng từ nhiễu tới dữ liệu.** Một chiều cho dễ nhìn. Mỗi mẫu là một cặp: $x_0$ lấy từ $\mathcal N(0,1)$ tại thời gian $t=0$ (nhiễu, chấm xám) và $x_1$ lấy từ dữ liệu hai cụm quanh $-2$ và $+2$ tại $t=1$ (chấm đỏ). Ta nối mỗi cặp bằng một **đoạn thẳng** trong mặt phẳng (thời gian, vị trí). Hình trái vẽ 40 đoạn như vậy.
#
# Đọc hình: độ dốc của một đoạn thẳng chính là vận tốc của điểm chạy dọc nó. Độ dốc đó phụ thuộc vào những gì (hai đầu mút nào), và có đổi theo thời gian $t$ trên cùng một đoạn không? Các đoạn có cắt nhau không?

# %%
import numpy as np
import matplotlib.pyplot as plt

rng = np.random.default_rng(0)
n = 40
x0 = rng.standard_normal(n)
x1 = rng.choice([-2.0, 2.0], size=n) + 0.3 * rng.standard_normal(n)

fig, ax = plt.subplots(figsize=(5.6, 3.6))
for a, b in zip(x0, x1):
    ax.plot([0, 1], [a, b], color="tab:blue", alpha=0.45, lw=0.9)
ax.scatter(np.zeros(n), x0, color="gray", s=14, zorder=3, label="nhiễu x0 (t = 0)")
ax.scatter(np.ones(n), x1, color="tab:red", s=14, zorder=3, label="dữ liệu x1 (t = 1)")
ax.set_xlabel("thời gian t")
ax.set_ylabel("vị trí x")
ax.legend(fontsize=8, loc="upper left")
plt.tight_layout()
plt.show()

# %% [markdown]
# **Mô hình chỉ thấy vị trí và thời gian.** Mô hình $v_\theta(x_t,t)$ nhận vị trí $x_t$ và thời gian $t$, **không** biết nó đang ở đoạn thẳng của cặp nào. Hình dưới lấy 600 cặp và đứng ở $t=0.5$: trục ngang là vị trí của điểm trên đoạn thẳng của cặp, trục dọc là vận tốc của đoạn đó (hiệu hai đầu mút). Đường đỏ là trung bình của vận tốc theo từng khoảng vị trí.
#
# Đọc hình: ở cùng một vị trí, vận tốc đích có **một giá trị** hay **nhiều giá trị khác nhau**? Vậy khi hồi quy bình phương, $v_\theta(x,t)$ sẽ học ra con số nào? Đường đỏ (trung bình) đi từ vị trí nhiễu về hai cụm dữ liệu ra sao?

# %%
n = 600
x0 = rng.standard_normal(n)
x1 = rng.choice([-2.0, 2.0], size=n) + 0.3 * rng.standard_normal(n)
pos = 0.5 * (x0 + x1)
vel = x1 - x0
bins = np.linspace(-2, 2, 21)
idx = np.digitize(pos, bins)
centers = 0.5 * (bins[1:] + bins[:-1])
mean_vel = np.array([vel[idx == k + 1].mean() if np.any(idx == k + 1) else np.nan for k in range(len(centers))])

fig, ax = plt.subplots(figsize=(5.6, 3.6))
ax.scatter(pos, vel, s=6, alpha=0.4)
ax.plot(centers, mean_vel, color="tab:red", lw=2, label="trung bình theo vị trí")
ax.set_xlabel("vị trí x_t tại t = 0.5")
ax.set_ylabel("vận tốc đích x1 − x0")
ax.legend(fontsize=8)
plt.tight_layout()
plt.show()
