# %% [markdown]
# Nhắc lại bài trước: với $C = 10$ lớp, cho logit lớp đúng bằng $m$ và mọi logit sai bằng 0. Cross-entropy thường chỉ nhìn $-\log p_y$, nên càng tăng $m$ loss càng nhỏ.
#
# Label smoothing thay one-hot bằng $q = (1-\varepsilon)\,\text{onehot} + \varepsilon / C$. Trước khi code, hãy tự vẽ trong đầu đường cong tương ứng cho $\varepsilon = 0.1$.

# %%
import numpy as np
import matplotlib.pyplot as plt

C = 10
margins = np.linspace(-2, 20, 200)
# logits = [m, 0, 0, ..., 0]; lớp đúng là lớp 0
log_norm = np.logaddexp(margins, np.log(C - 1))
plain = log_norm - margins

plt.figure(figsize=(6, 3.2))
plt.plot(margins, plain, label="cross-entropy thường")
plt.axhline(0, color="k", lw=0.6)
plt.xlabel("m = logit lớp đúng − logit lớp sai")
plt.ylabel("loss")
plt.title("C = 10 lớp")
plt.legend()
plt.show()
