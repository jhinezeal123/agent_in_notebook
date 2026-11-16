# %% [markdown]
# Một kernel nhỏ trượt trên ảnh; ở mỗi vị trí ta nhân từng ô rồi cộng lại. Kernel khác nhau "nhìn thấy" những thứ khác nhau: cạnh dọc, cạnh ngang, hay làm mờ.
#
# Cell dưới tự viết một bản **chậm, một kênh, không stride, không padding** để có hình. Bài làm của bạn tổng quát hơn nhiều.

# %%
import numpy as np
import matplotlib.pyplot as plt

img = np.zeros((32, 32))
img[8:24, 6:14] = 1.0                                # một hình chữ nhật
yy, xx = np.mgrid[:32, :32]
img[(yy - 16) ** 2 + (xx - 23) ** 2 < 30] = 0.6      # một hình tròn

def slide_one_channel(a, k):
    kh, kw = k.shape
    rows, cols = a.shape[0] - kh + 1, a.shape[1] - kw + 1
    res = np.empty((rows, cols))
    for r in range(rows):
        for c in range(cols):
            res[r, c] = np.sum(a[r:r + kh, c:c + kw] * k)
    return res

kernels = {
    "cạnh dọc": np.array([[1, 0, -1], [2, 0, -2], [1, 0, -1]], float),
    "cạnh ngang": np.array([[1, 2, 1], [0, 0, 0], [-1, -2, -1]], float),
    "làm mờ": np.ones((3, 3)) / 9,
}
fig, ax = plt.subplots(1, 4, figsize=(13, 3.2))
ax[0].imshow(img, cmap="gray")
ax[0].set_title("ảnh 32×32")
for a, (name, k) in zip(ax[1:], kernels.items()):
    a.imshow(slide_one_channel(img, k), cmap="RdBu_r")
    a.set_title(f"{name} → 30×30")
for a in ax:
    a.axis("off")
plt.tight_layout()
plt.show()

# %% [markdown]
# **Kích thước output.** Pad thêm $p$ ô mỗi phía, cửa sổ $k$ nhảy mỗi lần $s$ ô. Hình dưới vẽ ảnh $n \times n$ (ô xanh), viền pad (ô xám), khung đỏ là cửa sổ đầu tiên, và mỗi chấm đỏ là **góc trên-trái** của một vị trí cửa sổ. Đếm số chấm mỗi hàng rồi đối chiếu với công thức trong đề. Ở hình thứ ba, hàng và cột cuối có được cửa sổ nào phủ không?

# %%
from matplotlib.patches import Rectangle

def draw_positions(ax, n, k, s, p):
    size = n + 2 * p
    for r in range(size):
        for c in range(size):
            inside = p <= r < p + n and p <= c < p + n
            ax.add_patch(Rectangle((c, r), 1, 1, fc="#9ecae1" if inside else "#e0e0e0", ec="white"))
    starts = list(range(0, size - k + 1, s))
    for r in starts:
        for c in starts:
            ax.plot(c + 0.5, r + 0.5, "o", color="#d62728")
    ax.add_patch(Rectangle((0, 0), k, k, fill=False, ec="#d62728", lw=2.5))
    ax.set_xlim(0, size)
    ax.set_ylim(size, 0)
    ax.set_aspect("equal")
    ax.axis("off")
    ax.set_title(f"n={n}, k={k}, s={s}, p={p}: {len(starts)} vị trí mỗi chiều")

fig, ax = plt.subplots(1, 3, figsize=(13, 4.3))
draw_positions(ax[0], 7, 3, 1, 0)
draw_positions(ax[1], 7, 3, 2, 1)
draw_positions(ax[2], 8, 3, 2, 0)
plt.tight_layout()
plt.show()

# %% [markdown]
# **Cross-correlation hay convolution?** Trong toán, convolution *lật* kernel 180° trước khi trượt. Deep learning thì **không lật** (PyTorch, TensorFlow đều vậy). Thí nghiệm: cho kernel trượt qua một ảnh chỉ có **một điểm sáng**. Cái hiện ra là kernel, nhưng xoay 180°. Vì sao? (Gợi ý: khi cửa sổ ở vị trí (i, j), điểm sáng nằm ở ô nào của cửa sổ?)

# %%
delta = np.zeros((7, 7))
delta[3, 3] = 1.0
k = np.array([[1, 2, 0], [0, 0, 0], [0, 0, 3]], float)   # bất đối xứng để thấy hướng
fig, ax = plt.subplots(1, 3, figsize=(10, 3.2))
ax[0].imshow(k, cmap="viridis")
ax[0].set_title("kernel")
ax[1].imshow(slide_one_channel(delta, k), cmap="viridis")
ax[1].set_title("trượt (cross-correlation)\nqua một điểm sáng")
ax[2].imshow(slide_one_channel(delta, k[::-1, ::-1]), cmap="viridis")
ax[2].set_title("nếu lật kernel trước\n(convolution của toán)")
for a in ax:
    a.set_xticks([])
    a.set_yticks([])
plt.tight_layout()
plt.show()

# %% [markdown]
# **Nhiều kênh.** Với `C_in` kênh vào, mỗi kernel `w[f]` có shape `(C_in, kH, kW)`: nó trượt trên *cả khối* và cộng qua mọi kênh, cho ra **một** bản đồ. `C_out` kernel cho `C_out` bản đồ. Bảng shape để điền khi phác thảo:

# %%
rows = [
    ("x", "(N, C_in, H, W)"),
    ("x sau pad", "(N, C_in, H+2p, W+2p)"),
    ("w", "(C_out, C_in, kH, kW)"),
    ("w[:, :, u, v]", "(C_out, C_in)"),
    ("lát của x ứng với offset (u, v)", "(N, C_in, H_out, W_out)"),
    ("out", "(N, C_out, H_out, W_out)"),
]
for name, shape in rows:
    print(f"{name:>32}: {shape}")
