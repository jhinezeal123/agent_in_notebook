# %% [markdown]
# # Chẩn đoán triệu chứng: tràn số trong log_softmax
# Trong float64, $\exp(710)$ đã vượt ngưỡng cực đại ($\approx 1.8 \times 10^{308}$) và trở thành `inf`, kéo theo `inf / inf = nan`.

# %%
import numpy as np
import matplotlib.pyplot as plt

scales = np.linspace(1, 900, 30)
max_exp = []
for s in scales:
    with np.errstate(over="ignore"):
        val = np.exp(s)
    max_exp.append(1 if np.isfinite(val) else 0)

plt.figure(figsize=(5.5, 2.8))
plt.step(scales, max_exp, where="mid")
plt.yticks([0, 1], ["Tràn (inf/NaN)", "Hữu hạn"])
plt.xlabel("Giá trị logit cực đại")
plt.title("Trạng thái của np.exp(z) theo độ lớn logits")
plt.tight_layout()
plt.show()
