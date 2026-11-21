# %% [markdown]
# # Tác động của hệ số phạt $\lambda$ trong Ridge Regression
# Khi các đặc trưng có đa cộng tuyến mạnh, OLS ($\lambda = 0$) làm trọng số bùng nổ, còn Ridge thu gọn chuẩn $\|w\|_2$ một cách mượt mà trong khi vẫn giữ nguyên bias không bị phạt.

# %%
import numpy as np
import matplotlib.pyplot as plt

rng = np.random.default_rng(0)
N = 40
x1 = rng.normal(size=N)
x2 = x1 + rng.normal(scale=0.02, size=N)  # gần phụ thuộc tuyến tính
X = np.column_stack([x1, x2])
y = 2.0 * x1 - 1.5 * x2 + 5.0 + rng.normal(scale=0.2, size=N)

Xc = X - X.mean(axis=0, keepdims=True)
yc = y - y.mean()
lams = np.logspace(-5, 2, 40)
norms = []
for lam in lams:
    w = np.linalg.solve((Xc.T @ Xc) / N + lam * np.eye(2), (Xc.T @ yc) / N)
    norms.append(np.linalg.norm(w))

plt.figure(figsize=(5.5, 3))
plt.semilogx(lams, norms)
plt.xlabel("Hệ số phạt λ")
plt.ylabel("||w||₂")
plt.title("Chuẩn trọng số w giảm dần khi tăng λ (dù bias vẫn xấp xỉ 5.0)")
plt.tight_layout()
plt.show()
