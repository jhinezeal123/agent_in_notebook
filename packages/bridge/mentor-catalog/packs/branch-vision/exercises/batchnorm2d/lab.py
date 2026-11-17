# %% [markdown]
# **Ba điều cần thấy trước khi code Batch Normalization.**
#
# 1. **Mỗi kênh một thang đo riêng.** Trong một lớp conv, kênh 0 có thể là bộ lọc cạnh (giá trị nhỏ, quanh 0), kênh 2 là bộ lọc màu (giá trị lớn, lệch hẳn về một phía). Hình trái: histogram của từng kênh, gộp mọi ảnh trong batch và mọi vị trí $(h, w)$. Hình phải: **trung bình theo vị trí** của từng ảnh, mỗi chấm là một ảnh; ba cụm tách bạch theo kênh, còn trong một cụm các ảnh rất giống nhau. Từ đó, trước khi code, tự trả lời: một con số trung bình và một con số phương sai cho mỗi kênh, vậy đầu vào $(N, C, H, W)$ được gộp theo những trục nào?

# %%
import numpy as np
import matplotlib.pyplot as plt

rng = np.random.default_rng(0)
N, C, H, W = 8, 3, 16, 16
mu = np.array([-2.0, 0.0, 3.0])
sd = np.array([0.5, 1.0, 2.0])
x = rng.normal(size=(N, C, H, W)) * sd.reshape(1, C, 1, 1) + mu.reshape(1, C, 1, 1)

fig, ax = plt.subplots(1, 2, figsize=(9.5, 3.4))
for c in range(C):
    ax[0].hist(x[:, c].ravel(), bins=40, alpha=0.6, label=f"kênh {c}")
ax[0].set_xlabel("giá trị kích hoạt"); ax[0].set_ylabel("số lượng"); ax[0].legend(fontsize=8)
ax[0].set_title("giá trị của từng kênh (mọi ảnh, mọi vị trí)", fontsize=9)
for c in range(C):
    ax[1].scatter(np.full(N, c) + rng.uniform(-0.08, 0.08, N), x[:, c].mean(axis=(1, 2)), s=25)
ax[1].set_xticks(range(C)); ax[1].set_xlabel("kênh"); ax[1].set_ylabel("trung bình theo (h, w) của từng ảnh")
ax[1].set_title("mỗi chấm một ảnh", fontsize=9)
plt.tight_layout()
plt.show()

# %% [markdown]
# 2. **Chia $n$ hay chia $n-1$?** Với $n$ mẫu rút từ một phân phối có phương sai thật bằng 1, hai công thức "phương sai của mẫu" cho kết quả trung bình khác nhau. Hình dưới lặp lại thí nghiệm 20 000 lần cho mỗi $n$ và vẽ **giá trị trung bình** của từng công thức (đường nét đứt là sự thật: 1). Chỗ nào hai đường xa nhau, và xa bao nhiêu khi $n = 2$ hay $n = 8$? Với một batch ảnh $n = N \cdot H \cdot W$ rất lớn, chuyện này còn quan trọng không? Nhưng khi nào $n$ nhỏ? (Hãy nghĩ tới lớp conv cuối của mạng, nơi $H = W = 1$ hoặc $2$.)

# %%
ns = np.array([2, 3, 4, 6, 8, 16, 32, 64])
trials = 20000
chia_n, chia_n_tru_1 = [], []
for n in ns:
    s = rng.normal(size=(trials, n))
    chia_n.append(s.var(axis=1, ddof=0).mean())
    chia_n_tru_1.append(s.var(axis=1, ddof=1).mean())
fig, ax = plt.subplots(figsize=(5.2, 3.4))
ax.plot(ns, chia_n, "o-", label="chia n")
ax.plot(ns, chia_n_tru_1, "s-", label="chia n − 1")
ax.axhline(1.0, color="k", ls="--", lw=0.8)
ax.set_xscale("log", base=2); ax.set_xlabel("n (số mẫu)"); ax.set_ylabel("giá trị trung bình của công thức")
ax.legend(fontsize=8)
plt.tight_layout()
plt.show()

# %% [markdown]
# 3. **Trung bình trượt (running average) và `momentum`.** Mỗi batch cho một con số thống kê nhiễu (ở đây: trung bình thật là 3, mỗi batch đo được 3 cộng nhiễu). Running stats là một ước lượng được **kéo dần** về phía con số mới nhất, mỗi bước đi một phần `momentum` của quãng đường còn lại. Hình dưới vẽ đường ước lượng cho bốn giá trị `momentum`, bắt đầu từ 0 (giá trị khởi tạo của `running_mean`). Giá trị lớn thì sao với nhiễu, giá trị nhỏ thì sao với tốc độ tới đích? Vì sao `momentum = 0.1` là mặc định hợp lý, và vì sao ở lúc eval ta dùng con số này thay vì thống kê của một batch bất kỳ?

# %%
obs = 3.0 + rng.normal(scale=0.8, size=60)
fig, ax = plt.subplots(figsize=(6.2, 3.4))
ax.plot(obs, ".", color="gray", alpha=0.6, label="thống kê của từng batch")
for mom in [0.9, 0.5, 0.1, 0.02]:
    est, path = 0.0, []
    for v in obs:
        est = est + mom * (v - est)
        path.append(est)
    ax.plot(path, label=f"momentum = {mom}")
ax.axhline(3.0, color="k", ls="--", lw=0.8)
ax.set_xlabel("bước (batch)"); ax.set_ylabel("ước lượng"); ax.legend(fontsize=8, loc="lower right")
plt.tight_layout()
plt.show()
