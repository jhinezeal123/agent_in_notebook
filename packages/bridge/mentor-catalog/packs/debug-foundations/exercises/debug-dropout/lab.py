# %% [markdown]
# # Chẩn đoán triệu chứng: classic dropout vs inverted dropout
# Trong **inverted dropout**, chế độ eval phải là hàm đồng nhất ($y = x$), còn chế độ train chia cho $(1 - p)$ để giữ nguyên kỳ vọng $\mathbb{E}[y] = x$.

# %%
import numpy as np
import matplotlib.pyplot as plt

rng = np.random.default_rng(0)
x = np.ones(20000) * 4.0
ps = [0.0, 0.2, 0.5, 0.8]
buggy_train_means = [float((x * (rng.random(x.shape) >= p)).mean()) for p in ps]
buggy_eval_means = [float((x * (1 - p)).mean()) for p in ps]

plt.figure(figsize=(5.5, 3))
plt.plot(ps, [4.0]*len(ps), "--", color="gray", label="Kỳ vọng chuẩn (= 4.0)")
plt.plot(ps, buggy_train_means, "o-", label="Train hiện tại")
plt.plot(ps, buggy_eval_means, "s:", label="Eval hiện tại")
plt.xlabel("Xác suất drop p")
plt.ylabel("Giá trị trung bình đầu ra")
plt.legend()
plt.tight_layout()
plt.show()
