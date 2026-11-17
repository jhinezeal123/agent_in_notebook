# %% [markdown]
# **Lưới đồ chơi và vì sao cần học.** Ô code `GridWorld` phía trên đã chạy. Bên dưới: một agent đi **hoàn toàn ngẫu nhiên** trong lưới 4x4 (từ góc trên trái tới đích ở góc dưới phải, mỗi bước thưởng -1). Hình trái là một episode (đường đi, đậm dần theo thời gian); hình phải là số bước cần để tới đích qua 200 episode. Đường ngắn nhất chỉ có 6 bước. Câu hỏi để mang vào bài: nếu agent biết, ở mỗi ô, nó còn cách đích bao xa theo giá trị, nó đi thế nào?

# %%
import numpy as np
import matplotlib.pyplot as plt

walk = np.random.default_rng(0)
env = GridWorld(4, max_steps=5000)
s = env.reset()
path = [s]
done = False
while not done:
    s, _, done = env.step(int(walk.integers(4)))
    path.append(s)

lengths = []
for _ in range(200):
    s = env.reset()
    done = False
    steps = 0
    while not done:
        s, _, done = env.step(int(walk.integers(4)))
        steps += 1
    lengths.append(steps)

fig, axes = plt.subplots(1, 2, figsize=(10, 3.6))
ax = axes[0]
rows, cols = np.divmod(np.array(path), 4)
ax.set_xlim(-0.5, 3.5)
ax.set_ylim(3.5, -0.5)
ax.set_aspect("equal")
ax.set_xticks(range(4))
ax.set_yticks(range(4))
ax.grid(True)
for i in range(len(path) - 1):
    ax.plot(cols[i:i + 2], rows[i:i + 2], color=plt.cm.viridis(i / max(len(path) - 1, 1)), lw=2)
ax.scatter([0], [0], marker="s", s=120, color="tab:blue", label="bắt đầu")
ax.scatter([3], [3], marker="*", s=220, color="tab:red", label="đích")
ax.legend(loc="upper right", fontsize=8)
ax.set_title(f"một episode ngẫu nhiên: {len(path) - 1} bước")
axes[1].hist(lengths, bins=25, color="#4c78a8")
axes[1].axvline(6, color="k", ls="--", label="đường ngắn nhất: 6 bước")
axes[1].set_xlabel("số bước để tới đích")
axes[1].set_ylabel("số episode")
axes[1].legend()
axes[1].set_title(f"đi ngẫu nhiên: trung bình {np.mean(lengths):.0f} bước")
plt.tight_layout()
plt.show()

# %% [markdown]
# **Giá trị tối ưu của mỗi ô.** Vì thưởng -1 mỗi bước, giá trị tối ưu của một ô chỉ phụ thuộc số bước tới đích (khoảng cách Manhattan $d$). Với $\gamma = 0.95$ nó là $-(1 + \gamma + \dots + \gamma^{d-1})$. Hình dưới là giá trị đó ở từng ô: đây là **đích đến của việc học**, bạn không phải tính nó trong bài; Q-learning phải tìm ra nó chỉ từ các bước $(s, a, r, s')$ trải nghiệm được. Để ý ô sát đích: giá trị bằng đúng -1, nhờ phần tương lai ở đích bằng 0.

# %%
gamma = 0.95
dist = np.array([[(3 - r) + (3 - c) for c in range(4)] for r in range(4)])
value = -(1 - gamma ** dist) / (1 - gamma)
fig, ax = plt.subplots(figsize=(4.4, 4))
im = ax.imshow(value, cmap="viridis")
for r in range(4):
    for c in range(4):
        ax.text(c, r, f"{value[r, c]:.2f}", ha="center", va="center", color="w" if value[r, c] < -2.5 else "k", fontsize=9)
ax.set_title("giá trị tối ưu V*(s), gamma = 0.95")
plt.colorbar(im)
plt.tight_layout()
plt.show()

# %% [markdown]
# **Một bước, bằng số.** Giả sử ở ô `s` bạn làm hành động `a`, nhận $r = -1$, và rơi vào ô `s'` có $Q(s', \cdot) = (-3, -2, -4, -5)$, $\gamma = 0.9$. Tự tính tay hai target: nếu bước này **không** kết thúc episode, và nếu nó **kết thúc** episode (`s'` là đích). Chúng khác nhau bao nhiêu, và nếu ô đích chưa từng được cập nhật (toàn 0) thì khi nào hai cách tính cho cùng một số?
