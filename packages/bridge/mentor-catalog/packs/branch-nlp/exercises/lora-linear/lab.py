# %% [markdown]
# **Hai ý của LoRA, nhìn bằng số.**
#
# 1. **Tiết kiệm tham số.** Một ma trận $W$ cỡ $d \times d$ có $d^2$ số. Độ lệch hạng thấp $\Delta W = B A$ với $B \in \mathbb{R}^{d \times r}$, $A \in \mathbb{R}^{r \times d}$ chỉ cần $2dr$ số. Hình trái: với $d = 768$ (cỡ GPT-2 small), số tham số học được theo $r$ (trục log). Hình phải: *hạng* của một ma trận $\Delta W$ lấy ngẫu nhiên đầy đủ so với $B A$ có hạng $r$: nhìn các **singular value** của chúng. Đường đứt là hạng $r = 4$. Giả thuyết của paper: thay đổi cần để thích nghi với một tác vụ mới nằm gần một không gian hạng thấp như cột bên phải.

# %%
import numpy as np
import matplotlib.pyplot as plt

d = 768
ranks = np.array([1, 2, 4, 8, 16, 64, 256])
fig, ax = plt.subplots(1, 2, figsize=(10, 3.4))
ax[0].plot(ranks, 2 * d * ranks, "o-", label="LoRA: 2·d·r")
ax[0].axhline(d * d, color="gray", ls=":", label=f"fine-tune cả W: d² = {d * d:,}")
ax[0].set_xscale("log", base=2); ax[0].set_yscale("log")
ax[0].set_xlabel("hạng r"); ax[0].set_ylabel("số tham số học được")
ax[0].legend(fontsize=8)

rng = np.random.default_rng(0)
full = rng.normal(size=(64, 64))
low = rng.normal(size=(64, 4)) @ rng.normal(size=(4, 64))
for name, M in [("ΔW đầy đủ (ngẫu nhiên)", full), ("B·A với r = 4", low)]:
    s = np.linalg.svd(M, compute_uv=False)
    ax[1].plot(s / s[0], "o-", ms=3, label=name)
ax[1].axvline(3.5, color="k", ls="--", lw=0.8)
ax[1].set_xlabel("chỉ số singular value"); ax[1].set_ylabel("singular value (chia cho lớn nhất)")
ax[1].legend(fontsize=8)
plt.tight_layout()
plt.show()

# %% [markdown]
# **Vì sao không để cả $A$ và $B$ cùng bằng 0?** Thu bài toán về hai số vô hướng: $y = b\,a\,x$, muốn $y = 1$ khi $x = 1$, loss $L = (b a - 1)^2$. Gradient: $\partial L / \partial a = 2(ba-1)\,b$ và $\partial L / \partial b = 2(ba-1)\,a$. Hình dưới vẽ trường gradient (mũi tên là hướng **đi xuống**) trên mặt phẳng $(a, b)$ và ba quỹ đạo gradient descent bắt đầu từ ba điểm. Hãy nhìn: quỹ đạo nào kẹt, quỹ đạo nào chạy tới đường $ba = 1$, và điểm xuất phát nào tương ứng với "$B = 0$, $A$ ngẫu nhiên" của LoRA? Từ đó, trước khi code, tự trả lời: nếu cả $A$ và $B$ cùng khởi tạo bằng 0 thì adapter có học được không?

# %%
a, b = np.meshgrid(np.linspace(-1.6, 1.6, 17), np.linspace(-1.6, 1.6, 17))
ga, gb = 2 * (a * b - 1) * b, 2 * (a * b - 1) * a
fig, ax = plt.subplots(figsize=(4.6, 4.2))
ax.quiver(a, b, -ga, -gb, color="#b0b0b0", angles="xy", scale=70)
t_ = np.linspace(0.3, 2.0, 200)
ax.plot(t_, 1 / t_, "k--", lw=0.8, label="ba = 1 (loss = 0)")
for (a0, b0), c, label in [((0.0, 0.0), "tab:red", "a = 0, b = 0"), ((0.8, 0.0), "tab:green", "a ≠ 0, b = 0"), ((0.0, 0.8), "tab:blue", "a = 0, b ≠ 0")]:
    pa, pb, path = a0, b0, [(a0, b0)]
    for _ in range(300):
        g_a, g_b = 2 * (pa * pb - 1) * pb, 2 * (pa * pb - 1) * pa
        pa, pb = pa - 0.05 * g_a, pb - 0.05 * g_b
        path.append((pa, pb))
    path = np.array(path)
    ax.plot(path[:, 0], path[:, 1], "-", color=c, label=label)
    ax.plot(a0, b0, "o", color=c)
ax.set_xlabel("a"); ax.set_ylabel("b"); ax.set_xlim(-1.6, 1.6); ax.set_ylim(-1.6, 1.6)
ax.legend(fontsize=7, loc="upper right")
plt.tight_layout()
plt.show()
