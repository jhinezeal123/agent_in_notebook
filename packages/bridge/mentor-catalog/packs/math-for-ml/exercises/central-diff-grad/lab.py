# %% [markdown]
# # So sánh sai số sai phân tiến $O(\varepsilon)$ và sai phân trung tâm $O(\varepsilon^2)$
# Thử trên $f(x) = x^3$ tại $x = 1.5$ (đạo hàm đúng $f'(1.5) = 6.75$) khi $\varepsilon$ giảm từ $10^{-1}$ xuống $10^{-10}$.

# %%
import numpy as np
import matplotlib.pyplot as plt

f = lambda t: t ** 3
x0, exact = 1.5, 3 * (1.5 ** 2)
epsilons = np.logspace(-10, -1, 40)
err_fwd = [abs((f(x0 + e) - f(x0)) / e - exact) for e in epsilons]
err_cen = [abs((f(x0 + e) - f(x0 - e)) / (2 * e) - exact) for e in epsilons]

plt.figure(figsize=(5.5, 3))
plt.loglog(epsilons, err_fwd, "o-", markersize=3, label="Sai phân tiến O(ε)")
plt.loglog(epsilons, err_cen, "s-", markersize=3, label="Sai phân trung tâm O(ε²)")
plt.xlabel("Bước nhảy ε")
plt.ylabel("Sai số tuyệt đối |g_num - g_true|")
plt.legend()
plt.title("Đánh đổi giữa sai số cắt cụt và sai số làm tròn float64")
plt.tight_layout()
plt.show()
