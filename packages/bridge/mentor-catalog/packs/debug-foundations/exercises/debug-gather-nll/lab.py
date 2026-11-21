# %% [markdown]
# # Chẩn đoán triệu chứng: loss phụ thuộc vào số lượng padding
# Nếu các token thật giữ nguyên nhưng ta đệm thêm nhiều token padding (mask = 0),
# NLL trung bình trên các token thật **phải giữ nguyên không đổi**.

# %%
import numpy as np
import matplotlib.pyplot as plt

pad_ratios = np.linspace(0.0, 0.8, 9)
true_loss = np.full_like(pad_ratios, 1.5)
buggy_loss = true_loss * (1.0 - pad_ratios)

plt.figure(figsize=(5.5, 3))
plt.plot(pad_ratios * 100, true_loss, "o-", label="Kỳ vọng (bất biến với padding)")
plt.plot(pad_ratios * 100, buggy_loss, "s--", label="Triệu chứng thực tế")
plt.xlabel("Tỉ lệ padding trong batch (%)")
plt.ylabel("Loss")
plt.legend()
plt.tight_layout()
plt.show()
