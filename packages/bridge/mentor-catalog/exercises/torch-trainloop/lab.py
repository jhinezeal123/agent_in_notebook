# %% [markdown]
# **Dropout làm mô hình "ngẫu nhiên" khi ở chế độ train.** Đưa **cùng một** đầu vào qua một MLP có dropout 300 lần ở chế độ train: mỗi lần một mask khác, nên logit đầu ra nhảy lung tung (histogram). Ở chế độ eval dropout tắt, đầu ra cố định (vạch đen). Một con số đánh giá mà mỗi lần gọi lại ra một giá trị khác thì không dùng để so sánh mô hình được.

# %%
import numpy as np
import torch
import torch.nn as nn
import matplotlib.pyplot as plt

torch.manual_seed(0)
net = nn.Sequential(nn.Linear(4, 32), nn.ReLU(), nn.Dropout(0.5), nn.Linear(32, 1))
x = torch.randn(1, 4)

net.train()
with torch.no_grad():
    draws = [float(net(x)) for _ in range(300)]
net.eval()
with torch.no_grad():
    fixed = float(net(x))

plt.figure(figsize=(7, 3))
plt.hist(draws, bins=30, alpha=0.7, label="chế độ train (300 lần)")
plt.axvline(fixed, color="black", lw=2, label="chế độ eval")
plt.xlabel("logit đầu ra cho cùng một x"); plt.legend(fontsize=8)
plt.tight_layout()
plt.show()

# %% [markdown]
# **Trong `no_grad`, PyTorch không ghi đồ thị.** Ngoài `no_grad`, mỗi phép tính trên tham số cần gradient đều để lại một nút (`grad_fn`) giữ các tensor trung gian cho backward; lúc đánh giá ta không bao giờ gọi backward nên đó là bộ nhớ phí.

# %%
out = net(x)
print("ngoài no_grad: requires_grad =", out.requires_grad, "| grad_fn =", type(out.grad_fn).__name__)
with torch.no_grad():
    out = net(x)
print("trong no_grad: requires_grad =", out.requires_grad, "| grad_fn =", out.grad_fn)

# %% [markdown]
# **Trung bình theo batch hay theo mẫu.** Một epoch có 4 batch: ba batch đủ 64 mẫu và một batch cuối chỉ 3 mẫu, mà 3 mẫu đó tình cờ có loss cao. Lấy trung bình 4 con số loss của batch thì batch 3 mẫu nặng ngang batch 64 mẫu; trung bình theo mẫu mới là loss trung bình thật của tập dữ liệu.

# %%
rng = np.random.default_rng(0)
sizes = [64, 64, 64, 3]
per_sample = [rng.gamma(2.0, 0.3, size=n) + (2.0 if n == 3 else 0.0) for n in sizes]
batch_means = [s.mean() for s in per_sample]
by_batch = np.mean(batch_means)
by_sample = np.concatenate(per_sample).mean()

plt.figure(figsize=(7, 3))
plt.bar(range(4), batch_means, width=0.6, color="tab:gray")
for i, n in enumerate(sizes):
    plt.text(i, batch_means[i] + 0.05, f"n = {n}", ha="center", fontsize=8)
plt.axhline(by_batch, color="tab:red", ls="--", label=f"trung bình theo batch = {by_batch:.2f}")
plt.axhline(by_sample, color="tab:blue", label=f"trung bình theo mẫu = {by_sample:.2f}")
plt.xticks(range(4), [f"batch {i + 1}" for i in range(4)]); plt.ylabel("loss trung bình của batch")
plt.legend(fontsize=8); plt.tight_layout()
plt.show()
