# %% [markdown]
# # Độ bất thuần Gini và đường cong độ lợi thông tin theo ngưỡng chia
# Khi quét ngưỡng $\tau$ trên một đặc trưng 1D, độ giảm Gini đạt đỉnh đúng tại ranh giới tách hai lớp rõ nhất.

# %%
import numpy as np
import matplotlib.pyplot as plt

x = np.array([1.0, 1.5, 2.0, 2.2, 4.0, 4.5, 5.0, 5.5])
y = np.array([0, 0, 0, 1, 1, 1, 1, 1])
def gini(a):
    if len(a) == 0: return 0.0
    _, c = np.unique(a, return_counts=True)
    p = c / len(a)
    return float(1.0 - np.sum(p * p))

mids = 0.5 * (x[:-1] + x[1:])
gains = [gini(y) - (len(y[x <= m])*gini(y[x <= m]) + len(y[x > m])*gini(y[x > m])) / len(y) for m in mids]

plt.figure(figsize=(5.5, 3))
plt.plot(mids, gains, "o-")
plt.xlabel("Ngưỡng chia τ")
plt.ylabel("Độ giảm Gini (ΔG)")
plt.title("Quét ngưỡng chia trên 1 đặc trưng")
plt.tight_layout()
plt.show()
