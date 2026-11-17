# %% [markdown]
# **Hai con số để biết trước khi train.**
#
# 1. **Learning rate theo Eq. 3 (§5.3):** tăng tuyến tính trong `warmup_steps` bước đầu rồi giảm theo $\text{step}^{-0.5}$. Hình trái vẽ đường đi của lr với $d_\text{model}=64$ (hệ số nhân 0.5) cho ba giá trị warmup. Đỉnh càng thấp và càng muộn khi warmup càng lớn: bạn chọn warmup nào cho 4000 bước?
# 2. **Sàn của loss với label smoothing.** Đoán đều trên 13 token cho loss $\ln 13$; nhưng với label smoothing $\epsilon = 0.1$ thì ngay cả mô hình hoàn hảo cũng không về 0: phân phối đích có $0.9 + 0.1/13$ ở token đúng và $0.1/13$ ở mỗi token sai. Hình phải: loss của một mô hình dự đoán đúng phân phối đó, theo mức tự tin $p$ vào token đúng.

# %%
import numpy as np
import matplotlib.pyplot as plt

d_model = 64
steps = np.arange(1, 4001)
fig, ax = plt.subplots(1, 2, figsize=(10, 3.2))
for warmup in [100, 400, 1600]:
    lr = 0.5 * d_model ** -0.5 * np.minimum(steps ** -0.5, steps * warmup ** -1.5)
    ax[0].plot(steps, lr, label=f"warmup = {warmup}")
ax[0].set_xlabel("bước"); ax[0].set_ylabel("learning rate"); ax[0].legend(fontsize=8)

V, eps = 13, 0.1
target = np.full(V, eps / V)
target[0] += 1 - eps                                   # phân phối đích sau label smoothing
p = np.linspace(0.3, 0.999, 200)                       # mức tự tin vào token đúng
q = np.stack([p] + [(1 - p) / (V - 1)] * (V - 1), axis=1)
loss = -(target * np.log(q)).sum(axis=1)
ax[1].plot(p, loss)
ax[1].axhline(np.log(V), color="gray", ls=":", label=f"đoán đều: ln 13 = {np.log(V):.2f}")
ax[1].axhline(loss.min(), color="k", ls="--", label=f"sàn = {loss.min():.2f}")
ax[1].set_xlabel("xác suất mô hình gán cho token đúng"); ax[1].set_ylabel("cross-entropy"); ax[1].legend(fontsize=8)
plt.tight_layout()
plt.show()
