# %% [markdown]
# **Một thưởng ở xa còn nặng bao nhiêu?** $G_t$ là tổng các thưởng từ bước $t$ trở đi, nhưng thưởng ở $k$ bước phía sau bị nhân với $\gamma^k$. Hình dưới vẽ **trọng số $\gamma^k$** theo khoảng cách $k$ cho vài giá trị $\gamma$ (chưa tính $G$ nào cả, chỉ vẽ cái "cân" mà mỗi thưởng bị đặt lên). Chấm đen trên mỗi đường đánh dấu $k = 1/(1-\gamma)$, tầm nhìn xa hiệu dụng. Trước khi code, đoán: với $\gamma = 0.9$ thì thưởng cách 10 bước còn nặng cỡ bao nhiêu phần so với thưởng ngay lập tức? Với $\gamma = 0.99$ thì sao, và $\gamma = 1$ có nghĩa là gì cho một episode dài?

# %%
import numpy as np
import matplotlib.pyplot as plt

steps = np.arange(0, 61)
fig, ax = plt.subplots(figsize=(6.5, 3.6))
for g in [0.0, 0.5, 0.9, 0.99]:
    ax.plot(steps, g ** steps, label=f"gamma = {g}")
    if 0 < g < 1:
        horizon = 1.0 / (1.0 - g)
        if horizon <= 60:
            ax.plot([horizon], [g ** horizon], "ko")
ax.set_xlabel("k: thưởng nằm sau bước hiện tại bao nhiêu bước")
ax.set_ylabel("trọng số gamma^k")
ax.legend()
plt.tight_layout()
plt.show()
print("gamma = 0.9, k = 10:", round(0.9 ** 10, 3), "| gamma = 0.99, k = 10:", round(0.99 ** 10, 3))

# %% [markdown]
# **Mỗi $G_t$ nhìn thấy những thưởng nào?** Hình dưới là một mảng 8 bước thuộc **hai episode** (bước 0-3 và bước 4-7, `done` ở bước 3 và 7). Hàng $t$ cho biết $G_t$ gồm những thưởng $r_s$ nào và với trọng số bao nhiêu (ô trống = không dính). Đọc hình rồi nghĩ: (1) $G_t$ không bao giờ nhìn về phía nào của thời gian? (2) hai khối vuông nói gì về ranh giới episode? (3) nếu muốn tính cả cột này bằng cách cộng từng ô thì tốn bao nhiêu phép, và quan hệ $G_t = r_t + \gamma G_{t+1}$ cho cách rẻ hơn thế nào?

# %%
T, gamma = 8, 0.8
t_idx = np.arange(T)
episode = t_idx // 4
dist = t_idx[None, :] - t_idx[:, None]
weight = np.where((dist >= 0) & (episode[:, None] == episode[None, :]), gamma ** np.maximum(dist, 0), np.nan)

fig, ax = plt.subplots(figsize=(5.2, 4.4))
im = ax.imshow(weight, cmap="viridis", vmin=0, vmax=1)
for i in range(T):
    for j in range(T):
        if not np.isnan(weight[i, j]):
            ax.text(j, i, f"{weight[i, j]:.2f}", ha="center", va="center", color="white", fontsize=8)
ax.set_xlabel("s: thưởng r_s")
ax.set_ylabel("t: return G_t")
ax.set_xticks(range(T))
ax.set_yticks(range(T))
ax.set_title("Trọng số của r_s trong G_t (gamma = 0.8)")
plt.colorbar(im, ax=ax, fraction=0.046)
plt.tight_layout()
plt.show()
