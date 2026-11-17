# %% [markdown]
# **Temperature.** Cùng một vector logits của 8 token, đem chia cho `temperature` rồi mới đổi thành xác suất. Hình dưới vẽ ba phân phối cho `temperature` = 0.3, 1 và 3. Để ý hai điều: token cao nhất luôn là cột đó dù temperature bao nhiêu (thứ tự xếp hạng không đổi), và độ nhọn của phân phối thay đổi thế nào. Trước khi code, tự đoán: `temperature` → 0 và `temperature` → ∞ thì ba hình dồn về dạng nào?

# %%
import numpy as np
import matplotlib.pyplot as plt

z = np.array([2.5, 2.0, 1.0, 0.6, 0.0, -0.5, -1.0, -2.0])
fig, ax = plt.subplots(1, 3, figsize=(10, 3.2), sharey=True)
for a, temp in zip(ax, [0.3, 1.0, 3.0]):
    s = z / temp
    p = np.exp(s - s.max())
    p /= p.sum()
    a.bar(range(len(z)), p, color="#4c78a8")
    a.set_title(f"temperature = {temp}")
    a.set_xlabel("token")
ax[0].set_ylabel("xác suất")
plt.tight_layout()
plt.show()

# %% [markdown]
# **Top-k cắt đuôi.** Với một phân phối xác suất cho 30 token (đã sắp giảm dần), top-k giữ `k` token đầu, rồi các xác suất còn lại được chuẩn hóa lại để cộng thành 1. Hình trái là phân phối gốc với phần bị cắt (đỏ) ứng với `k = 5`; hình phải là khối lượng xác suất còn lại sau khi cắt, theo `k`. Để ý: cắt đi các token đuôi chỉ bỏ một phần khối lượng nhỏ, và phần xác suất còn lại được dồn lên các token giữ lại.

# %%
rng = np.random.default_rng(0)
logits = np.sort(rng.normal(0, 1.5, size=30))[::-1]
p = np.exp(logits - logits.max())
p /= p.sum()
k = 5
fig, ax = plt.subplots(1, 2, figsize=(9, 3.2))
colors = ["#4c78a8" if i < k else "#e45756" for i in range(30)]
ax[0].bar(range(30), p, color=colors)
ax[0].set_title(f"phân phối gốc, k = {k}: đỏ là phần bị cắt")
ax[0].set_xlabel("token (xếp theo xác suất)")
ax[1].plot(range(1, 31), np.cumsum(p), "o-", color="#4c78a8")
ax[1].axvline(k, color="k", ls="--")
ax[1].set_title("khối lượng xác suất giữ lại theo k")
ax[1].set_xlabel("k")
ax[1].set_ylabel("tổng xác suất giữ lại")
plt.tight_layout()
plt.show()

# %% [markdown]
# **Cửa sổ ngữ cảnh.** Mô hình chỉ có `block_size` vị trí. Hình dưới là một prompt dài 5 token với `block_size = 8` được kéo dài thêm 8 token mới: mỗi hàng là một bước sinh, ô xanh là các token được đưa vào mô hình ở bước đó, ô xám là các token đã có nhưng *không* được nhìn thấy nữa. Để ý bước nào bắt đầu có ô xám, và ô xám nằm ở đầu hay ở cuối chuỗi.

# %%
block_size, prompt, new = 8, 5, 8
grid = np.full((new, prompt + new), np.nan)
for step in range(new):
    length = prompt + step
    lo = max(0, length - block_size)
    grid[step, :length] = 0.0
    grid[step, lo:length] = 1.0
fig, ax = plt.subplots(figsize=(7, 3.4))
from matplotlib.colors import ListedColormap
ax.imshow(np.ma.masked_invalid(grid), cmap=ListedColormap(["#c8c8c8", "#54a24b"]), vmin=0, vmax=1, aspect="auto")
ax.set_xlabel("vị trí trong chuỗi")
ax.set_ylabel("bước sinh")
ax.set_title("xanh: mô hình nhìn thấy, xám: đã có nhưng bị bỏ ra ngoài cửa sổ")
plt.tight_layout()
plt.show()
