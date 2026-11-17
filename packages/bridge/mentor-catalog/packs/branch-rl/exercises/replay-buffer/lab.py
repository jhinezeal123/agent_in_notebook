# %% [markdown]
# **Vì sao không học thẳng từ bước vừa chơi?** Một agent chơi liên tục sinh ra dữ liệu **tương quan mạnh**: trạng thái ở bước $t$ gần giống bước $t+1$. Bên dưới, một "quỹ đạo" là một bước đi ngẫu nhiên trong 2 chiều (đại diện cho trạng thái thay đổi từ từ). Hình trái: 32 bước **liên tiếp** vừa chơi (cách học không có bộ đệm) chỉ phủ một đám nhỏ. Hình phải: 32 transition **bốc ngẫu nhiên** từ 2000 bước đã lưu, phủ cả không gian. Mạng nơ-ron học tốt khi các mẫu trong một batch độc lập tương đối, và không "quên" vùng đã đi qua.

# %%
import numpy as np
import matplotlib.pyplot as plt

walk = np.random.default_rng(0)
trajectory = np.cumsum(0.3 * walk.standard_normal((2000, 2)), axis=0)
recent = trajectory[-32:]
picked = trajectory[walk.choice(len(trajectory), size=32, replace=False)]

fig, axes = plt.subplots(1, 2, figsize=(9, 3.8), sharex=True, sharey=True)
for ax, pts, title in [(axes[0], recent, "32 bước liên tiếp gần nhất"), (axes[1], picked, "32 bước bốc ngẫu nhiên từ 2000 bước đã lưu")]:
    ax.plot(trajectory[:, 0], trajectory[:, 1], color="#cccccc", lw=0.8)
    ax.scatter(pts[:, 0], pts[:, 1], s=22, color="tab:red")
    ax.set_title(title, fontsize=10)
plt.tight_layout()
plt.show()
print("độ lệch chuẩn trong batch, 32 bước liên tiếp:", recent.std(axis=0).round(2), "| bốc ngẫu nhiên:", picked.std(axis=0).round(2))

# %% [markdown]
# **Bộ đệm vòng, bằng hình.** Bộ đệm sức chứa 8; đã push 13 transition, đánh số theo thứ tự push (0, 1, ..., 12). Mỗi ô là một vị trí lưu trữ, số trong ô là transition đang nằm ở đó. Hình bên dưới cho kết quả mong đợi (viết tay, không phải code của bạn): transition 8 đến 12 đã ghi đè các transition 0 đến 4 ở đúng chỗ của chúng, còn 5, 6, 7 chưa bị đụng tới. Tự trả lời trước khi code: vị trí ghi tiếp theo là ô nào, và transition nào sẽ bị ghi đè tiếp? Quan hệ giữa số thứ tự push và vị trí ô là gì?

# %%
slots = [8, 9, 10, 11, 12, 5, 6, 7]
fig, ax = plt.subplots(figsize=(8, 2.2))
for i, item in enumerate(slots):
    age = 12 - item
    ax.add_patch(plt.Rectangle((i, 0), 0.9, 0.9, fc=plt.cm.YlOrRd(1 - age / 9), ec="k"))
    ax.text(i + 0.45, 0.45, str(item), ha="center", va="center", fontsize=13)
    ax.text(i + 0.45, -0.3, f"ô {i}", ha="center", va="center", fontsize=8)
ax.annotate("ghi kế tiếp", xy=(5.45, 0.95), xytext=(5.45, 1.5), ha="center", arrowprops=dict(arrowstyle="->"))
ax.set_xlim(-0.2, 8.2)
ax.set_ylim(-0.7, 1.9)
ax.axis("off")
ax.set_title("sức chứa 8, đã push 13 transition (màu đậm = mới)")
plt.tight_layout()
plt.show()

# %% [markdown]
# **Bẫy sức chứa.** Giả sử bạn tạo mảng lưu 100 ô nhưng mới push 7 transition. Nếu `sample` bốc vị trí trong khoảng 0 đến 99, những ô trống (toàn 0) sẽ lọt vào batch; transition giả này có $s = 0$, $r = 0$, và nó huấn luyện mạng trên dữ liệu không có thật. Tự hỏi: số "đã ghi" và số "sức chứa" là hai số khác nhau ở những lúc nào, và `len` phải báo số nào?
