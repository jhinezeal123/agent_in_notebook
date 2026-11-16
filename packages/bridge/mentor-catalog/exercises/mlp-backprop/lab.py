# %% [markdown]
# **Đồ thị tính toán**
#
# `X` → (· W1 + b1) → `z1` → ReLU → `h` → (· W2 + b2) → `out` → L
#
# Quy tắc chuỗi đi ngược: biết $\partial L/\partial \text{out}$, tính lần lượt $\partial L/\partial W_2$, $\partial L/\partial b_2$, $\partial L/\partial h$, $\partial L/\partial z_1$, rồi $\partial L/\partial W_1$, $\partial L/\partial b_1$. Mẹo: **gradient luôn cùng shape với thứ nó là gradient của** — dùng shape để đoán thứ tự nhân và chuyển vị.

# %%
import numpy as np
import matplotlib.pyplot as plt

z = np.linspace(-3, 3, 200)
fig, ax = plt.subplots(1, 2, figsize=(9, 3))
ax[0].plot(z, np.maximum(z, 0)); ax[0].set_title("ReLU(z)")
ax[1].plot(z, (z > 0).astype(float)); ax[1].set_title("ReLU'(z)")
for a in ax:
    a.axhline(0, color="gray", lw=0.5); a.axvline(0, color="gray", lw=0.5)
plt.tight_layout()
plt.show()

# %%
# Kiểm gradient bằng sai phân trung tâm, trên một hàm đơn giản.
rng = np.random.default_rng(0)
f = lambda w: np.sum(np.tanh(w) ** 2)
w = rng.normal(size=5)
eps = 1e-5
numeric = np.array([(f(w + eps * e) - f(w - eps * e)) / (2 * eps) for e in np.eye(5)])
analytic = 2 * np.tanh(w) * (1 - np.tanh(w) ** 2)
print("số:      ", numeric)
print("giải tích:", analytic)
print("sai lệch lớn nhất:", np.abs(numeric - analytic).max())

# %%
# Bảng shape để điền khi phác thảo (B = batch, D = vào, H = ẩn, O = ra).
for name, shape in [("X", "(B, D)"), ("W1", "(D, H)"), ("z1, h", "(B, H)"), ("W2", "(H, O)"), ("out, dout", "(B, O)")]:
    print(f"{name:>10}: {shape}")
