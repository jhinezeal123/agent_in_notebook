# %% [markdown]
# Nhắc lại bài Adam: mỗi tham số được chia cho $\sqrt{\hat v}$ của **riêng nó**. Hình dưới chạy Adam thường (chưa có decay) cho hai tham số trong câu dự đoán: A có gradient nhiễu lớn, B có gradient rất nhỏ, và vẽ $\sqrt{\hat v}$ của từng cái.
#
# Câu hỏi để tự nghĩ trước khi code: nếu cộng $\lambda\theta$ vào gradient, số hạng đó cũng bị chia cho $\sqrt{\hat v}$ này.

# %%
import numpy as np
import matplotlib.pyplot as plt

rng = np.random.default_rng(0)
steps, b2 = 1000, 0.999
sigma = {"A": 100.0, "B": 0.01}
fig, ax = plt.subplots(1, 2, figsize=(11, 3.2))
for name, s in sigma.items():
    g = rng.normal(scale=s, size=steps)
    v = np.zeros(steps)
    acc = 0.0
    for t in range(steps):
        acc = b2 * acc + (1 - b2) * g[t] ** 2
        v[t] = acc / (1 - b2 ** (t + 1))
    ax[0].plot(g[:200], lw=0.7, label=f"{name}: σ = {s}")
    ax[1].plot(np.sqrt(v), label=f"{name}")
ax[0].set_yscale("symlog", linthresh=0.01)
ax[0].set_title("Gradient (200 bước đầu)")
ax[1].set_yscale("log")
ax[1].set_title("√v̂ theo bước")
ax[1].set_xlabel("bước t")
for a in ax:
    a.legend()
plt.tight_layout()
plt.show()
