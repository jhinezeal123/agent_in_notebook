# %% [markdown]
# # Chẩn đoán triệu chứng: độ lớn bước cập nhật của Adam ở các bước đầu
# Với gradient không đổi $g = 1$ và $b_1 = 0.9, b_2 = 0.999$, bước cập nhật Adam chuẩn tại $t=1$ phải xấp xỉ $1.0 \times \text{lr}$.

# %%
import numpy as np
import matplotlib.pyplot as plt

b1, b2 = 0.9, 0.999
ts = np.arange(1, 30)
m, v = 0.0, 0.0
raw_step, corrected_step = [], []
for t in ts:
    m = b1 * m + (1 - b1) * 1.0
    v = b2 * v + (1 - b2) * 1.0
    raw_step.append(m / (np.sqrt(v) + 1e-8))
    corrected_step.append((m / (1 - b1**t)) / (np.sqrt(v / (1 - b2**t)) + 1e-8))

plt.figure(figsize=(5.5, 3))
plt.plot(ts, corrected_step, "o-", label="Adam chuẩn (≈ 1.0)")
plt.plot(ts, raw_step, "s--", label="Triệu chứng (bị vọt > 3× ở bước đầu)")
plt.xlabel("Bước t")
plt.ylabel("|Δp| / lr khi g = 1")
plt.legend()
plt.tight_layout()
plt.show()
