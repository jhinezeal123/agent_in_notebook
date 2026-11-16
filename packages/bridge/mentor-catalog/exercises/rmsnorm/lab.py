# %% [markdown]
# Nhắc lại bài trước: LayerNorm đưa **mỗi token** về trung bình 0, độ lệch chuẩn 1. Hình dưới đo hai con số đó cho 4 token có trung bình và độ lệch chuẩn rất khác nhau, trước và sau LayerNorm.
#
# RMSNorm chỉ còn phép chia cho $\sqrt{\tfrac1d\sum_k x_k^2 + \epsilon}$. Trước khi code, hãy đoán: với RMSNorm, các cột "sau" sẽ trông thế nào?

# %%
import numpy as np
import matplotlib.pyplot as plt

rng = np.random.default_rng(0)
locs = np.array([[4.0], [-2.0], [0.0], [0.5]])
scales = np.array([[1.0], [0.3], [3.0], [0.05]])
x = rng.normal(loc=locs, scale=scales, size=(4, 64))
centered = x - x.mean(axis=1, keepdims=True)
ln = centered / np.sqrt((centered ** 2).mean(axis=1, keepdims=True) + 1e-5)

fig, ax = plt.subplots(1, 2, figsize=(10, 3), sharex=True)
idx = np.arange(4)
ax[0].bar(idx - 0.2, x.mean(1), 0.4, label="trước")
ax[0].bar(idx + 0.2, ln.mean(1), 0.4, label="sau LayerNorm")
ax[0].set_title("Trung bình của từng token")
ax[1].bar(idx - 0.2, x.std(1), 0.4, label="trước")
ax[1].bar(idx + 0.2, ln.std(1), 0.4, label="sau LayerNorm")
ax[1].set_title("Độ lệch chuẩn của từng token")
for a in ax:
    a.set_xticks(idx)
    a.set_xlabel("token")
    a.axhline(0, color="k", lw=0.6)
ax[0].legend()
plt.tight_layout()
plt.show()
