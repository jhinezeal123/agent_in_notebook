# %% [markdown]
# # Chẩn đoán triệu chứng: RMSNorm vs dịch trung bình
# Với $x = [3, 3, 3, 3]$ và $\gamma = [1, 1, 1, 1]$, RMS của $x$ bằng $3$, nên $\operatorname{RMSNorm}(x) \approx [1, 1, 1, 1]$ — **không phải 0**.

# %%
import numpy as np
import matplotlib.pyplot as plt

x = np.array([[3.0, 3.0, 3.0, 3.0], [1.0, 2.0, 3.0, 4.0]])
expected_rms = np.sqrt((x * x).mean(axis=-1, keepdims=True) + 1e-6)
centered = x - x.mean(axis=-1, keepdims=True)

fig, ax = plt.subplots(figsize=(5.5, 3))
idx = np.arange(4)
ax.bar(idx - 0.18, (x / expected_rms)[0], width=0.35, label="RMSNorm chuẩn trên [3,3,3,3]")
ax.bar(idx + 0.18, (centered / np.sqrt((centered**2).mean(-1, keepdims=True) + 1e-6))[0], width=0.35, label="Triệu chứng (bị kéo về 0)")
ax.legend()
ax.set_title("Đầu ra trên token hằng số x = [3, 3, 3, 3]")
plt.tight_layout()
plt.show()
