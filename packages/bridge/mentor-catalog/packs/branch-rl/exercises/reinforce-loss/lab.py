# %% [markdown]
# **Vì sao cần baseline?** Một "bandit" ba tay với policy cố định (softmax của `logits`). Mỗi lần kéo tay $a$ ta nhận return $G$ = (giá trị của tay) + 10 + nhiễu. Mọi tay đều cho return cỡ 11-12: **return luôn dương**. Một mẫu gradient của $J=\mathbb{E}[G]$ theo logits là $G\cdot(\text{onehot}(a)-\pi)$. Hình trái là 3000 mẫu của thành phần logit 0 khi dùng nguyên $G$; hình phải khi dùng $G - b$ với $b$ là trung bình return. Hai hình có **cùng trung bình** (cùng gradient thật; chênh nhỏ chỉ do lấy mẫu hữu hạn), nhưng độ rộng khác nhau. Trước khi xem: đoán độ lệch chuẩn của hình phải bằng khoảng bao nhiêu lần hình trái, và baseline có làm lệch (bias) gradient không?

# %%
import numpy as np
import matplotlib.pyplot as plt

gen = np.random.default_rng(0)
logits = np.array([0.2, 0.0, -0.2])
pi = np.exp(logits) / np.exp(logits).sum()
arm_value = np.array([1.0, 1.5, 2.0])
n = 3000
a = gen.choice(3, size=n, p=pi)
G = 10.0 + arm_value[a] + gen.standard_normal(n)
score = np.eye(3)[a] - pi
b = G.mean()

raw = (G[:, None] * score)[:, 0]
centered = ((G - b)[:, None] * score)[:, 0]
print(f"không baseline: trung bình {raw.mean():+.3f}, độ lệch chuẩn {raw.std():.3f}")
print(f"có baseline   : trung bình {centered.mean():+.3f}, độ lệch chuẩn {centered.std():.3f}")

fig, axes = plt.subplots(1, 2, figsize=(9, 3.4), sharex=True, sharey=True)
lo, hi = raw.min(), raw.max()
for ax, vals, title in [(axes[0], raw, "dùng G"), (axes[1], centered, "dùng G - b")]:
    ax.hist(vals, bins=60, range=(lo, hi), color="tab:blue", alpha=0.8)
    ax.axvline(vals.mean(), color="red", lw=1.5, label="trung bình")
    ax.set_title(title)
    ax.set_xlabel("mẫu gradient theo logit 0")
axes[0].legend()
plt.tight_layout()
plt.show()

# %% [markdown]
# **Vì sao không đi đường vòng qua xác suất?** Với hai hành động, logits là $(x, 0)$. Log-xác suất của hành động 0 là $\log\dfrac{e^{x}}{e^{x}+1}$. Hình dưới so hai cách tính trong float32 khi $x$ trượt từ -150 tới 20: đường xanh là "tính xác suất rồi lấy log" (đường bị đứt khi xác suất làm tròn xuống 0, log thành $-\infty$), đường cam là cách ổn định. Trả lời: tới $x$ khoảng bao nhiêu thì cách thứ nhất hỏng, và loss của REINFORCE (nhân log-xác suất với $A$) trở thành gì khi hành động đã chọn có xác suất "bằng 0"?

# %%
x = np.linspace(-150, 20, 400).astype(np.float32)
with np.errstate(divide="ignore", over="ignore"):
    p = np.exp(x) / (np.exp(x) + np.float32(1.0))
    naive = np.log(p)
stable = x - np.logaddexp(x.astype(np.float64), 0.0)

fig, ax = plt.subplots(figsize=(6.2, 3.6))
ax.plot(x, naive, label="log(exp(x) / (exp(x) + 1)) trong float32")
ax.plot(x, stable, "--", label="cách ổn định")
ax.set_xlabel("x (logit của hành động 0, logit kia bằng 0)")
ax.set_ylabel("log pi(a=0)")
ax.legend()
plt.tight_layout()
plt.show()
print("x nhỏ nhất mà cách 1 còn hữu hạn:", float(x[np.isfinite(naive)].min()))
