# %% [markdown]
# **Ma trận độ giống 2N × 2N.** Lấy $N = 6$ "ảnh", mỗi ảnh có hai view; embedding của hai view là cùng một vector gốc cộng nhiễu khác nhau. Xếp hai view thành $2N = 12$ vector (6 view đầu rồi 6 view sau), chuẩn hóa độ dài, và vẽ ma trận **cosine** giữa mọi cặp. Ô viền **đen** là đường chéo (một vector so với chính nó). Ô viền **đỏ** là cặp hai view của cùng một ảnh. Hãy nhìn và tự trả lời trước khi code: đường chéo có giá trị gì, và vì sao nó không nên góp mặt trong bài toán "đoán xem ai là view kia"? Ô đỏ của hàng $i$ nằm ở cột nào (có quy tắc theo $N$)? Hàng nào có ô đỏ không phải ô lớn nhất (ngoài đường chéo), và hàng đó sẽ chịu loss thế nào?

# %%
import numpy as np
import matplotlib.pyplot as plt

rng = np.random.default_rng(1)
N, D = 6, 16
base = rng.normal(size=(N, D))
views = np.concatenate([base + 0.5 * rng.normal(size=(N, D)), base + 0.5 * rng.normal(size=(N, D))])
zhat = views / np.linalg.norm(views, axis=1, keepdims=True)
cos = zhat @ zhat.T

fig, ax = plt.subplots(figsize=(5.4, 4.6))
im = ax.imshow(cos, cmap="viridis", vmin=-0.5, vmax=1.0)
for i in range(2 * N):
    ax.add_patch(plt.Rectangle((i - 0.5, i - 0.5), 1, 1, fill=False, ec="black", lw=1.8))
    j = (i + N) % (2 * N)
    ax.add_patch(plt.Rectangle((j - 0.5, i - 0.5), 1, 1, fill=False, ec="red", lw=1.8))
ax.axhline(N - 0.5, color="white", lw=0.8); ax.axvline(N - 0.5, color="white", lw=0.8)
ax.set_xlabel("vector j (6 view đầu | 6 view sau)"); ax.set_ylabel("vector i")
plt.colorbar(im, ax=ax, fraction=0.046, label="cosine")
plt.tight_layout()
plt.show()

# %% [markdown]
# **Temperature làm gì?** Lấy hàng 0 của ma trận trên, bỏ đường chéo, còn 11 ứng viên (1 positive và 10 negative). Chia cosine cho $\tau$ rồi đổi thành xác suất bằng softmax. Hình dưới: xác suất của từng ứng viên ở ba giá trị $\tau$ (cột đỏ là positive). Khi $\tau$ giảm, khối lượng xác suất dồn vào đâu? Positive có thắng cuộc không, và những negative nào còn "sống" khi $\tau$ nhỏ? Từ đó đoán: ở $\tau$ nhỏ, gradient của loss chủ yếu đến từ những negative nào?

# %%
others = [k for k in range(2 * N) if k != 0]
pos_idx = others.index(N)
fig, axes = plt.subplots(1, 3, figsize=(10.4, 3.1), sharey=True)
for ax, tau in zip(axes, [1.0, 0.3, 0.07]):
    s = cos[0, others] / tau
    p = np.exp(s - s.max())
    p /= p.sum()
    colors = ["tab:red" if k == pos_idx else "tab:blue" for k in range(len(others))]
    ax.bar(range(len(others)), p, color=colors)
    ax.set_title(f"τ = {tau}", fontsize=9)
    ax.set_xlabel("ứng viên (11 vector khác)")
axes[0].set_ylabel("xác suất")
plt.tight_layout()
plt.show()
