# %% [markdown]
# Một hàm bậc hai "dẹt" $f(x, y) = \tfrac12(x^2 + 25y^2)$: độ cong theo $y$ gấp 25 lần theo $x$. Xem SGD và Momentum đi thế nào (Adam là phần bạn tự viết).

# %%
import numpy as np
import matplotlib.pyplot as plt

grad = lambda p: np.array([p[0], 25 * p[1]])

def run(step, n=60):
    p, s, path = np.array([-4.0, 1.5]), None, []
    for _ in range(n):
        path.append(p.copy())
        p, s = step(p, grad(p), s)
    return np.array(path)

sgd = run(lambda p, g, s: (p - 0.07 * g, s))
mom = run(lambda p, g, s: (p - 0.03 * (g + 0.8 * (s if s is not None else 0)), g + 0.8 * (s if s is not None else 0)))
xs, ys = np.meshgrid(np.linspace(-5, 5, 200), np.linspace(-2, 2, 200))
plt.figure(figsize=(7, 3.5))
plt.contour(xs, ys, 0.5 * (xs ** 2 + 25 * ys ** 2), levels=20, cmap="Greys", linewidths=0.6)
plt.plot(*sgd.T, "o-", ms=3, label="SGD")
plt.plot(*mom.T, "o-", ms=3, label="Momentum")
plt.legend()
plt.title("Hai thuật toán trên hàm dẹt")
plt.show()

# %%
# Hệ số hiệu chỉnh bias 1 / (1 - β^t) theo số bước.
t = np.arange(1, 101)
plt.figure(figsize=(6, 3))
plt.plot(t, 1 / (1 - 0.9 ** t), label="1/(1-β1^t), β1=0.9")
plt.plot(t, 1 / (1 - 0.999 ** t), label="1/(1-β2^t), β2=0.999")
plt.yscale("log")
plt.xlabel("bước t")
plt.legend()
plt.show()
