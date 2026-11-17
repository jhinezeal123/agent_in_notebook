# %% [markdown]
# **Ảnh bị nhiễu dần.** Ta dựng một "ảnh" 32×32 (hình tròn có sọc trên nền tối) rồi cho chạy quá trình thuận của DDPM **từng bước một**, mỗi bước $x_t=\sqrt{1-\beta_t}\,x_{t-1}+\sqrt{\beta_t}\,\varepsilon$ (Eq. 2 của paper), với $\beta$ tăng tuyến tính từ $10^{-4}$ đến $0.02$ qua $T=1000$ bước, và chụp lại ảnh ở vài bước. Nhìn hình: ở bước nào bạn không còn thấy hình tròn nữa? Và ở bước cuối, ảnh còn giống ảnh gốc không?
#
# Cách làm trong lab tốn một phép tính cho **mỗi** bước. Trong lúc train DDPM, mỗi lần cập nhật ta cần ảnh ở một bước $t$ **ngẫu nhiên** (có thể là bước 800) cho **mỗi ảnh** của batch. Hãy nghĩ xem nếu phải đi từ $x_0$ qua 800 bước như lab thì sẽ ra sao; bài này viết phiên bản không cần đi qua từng bước.

# %%
import numpy as np
import matplotlib.pyplot as plt

yy, xx = np.mgrid[-1:1:32j, -1:1:32j]
img = np.where(xx**2 + yy**2 < 0.45, np.where(np.sin(10 * (xx + yy)) > 0, 1.0, 0.3), -1.0)

beta = np.linspace(1e-4, 0.02, 1000)
rng = np.random.default_rng(0)
show = [0, 50, 100, 200, 350, 600, 999]
frames = {}
x = img.copy()
for i, b in enumerate(beta):
    x = np.sqrt(1 - b) * x + np.sqrt(b) * rng.standard_normal(x.shape)
    if i in show:
        frames[i] = x.copy()

fig, ax = plt.subplots(1, len(show) + 1, figsize=(13, 2.0))
ax[0].imshow(img, cmap="gray", vmin=-2.5, vmax=2.5)
ax[0].set_title("ảnh gốc", fontsize=8)
for a, i in zip(ax[1:], show):
    a.imshow(frames[i], cmap="gray", vmin=-2.5, vmax=2.5)
    a.set_title(f"sau bước {i}", fontsize=8)
for a in ax:
    a.axis("off")
plt.tight_layout()
plt.show()

# %% [markdown]
# **Bẫy broadcasting.** Trong bài, mỗi ảnh của batch có hệ số riêng (vector shape `(B,)`) mà ảnh có shape `(B, C, H, W)`. Hình dưới thử nhân thẳng một vector 4 hệ số vào một batch 4 ảnh toàn số 1 shape `(4, 3, 5, 4)`: ý định là ảnh thứ $b$ nhân với `coef[b]`, nên mỗi ảnh lẽ ra phải là **một màu phẳng**. Chạy xem: có báo lỗi không? Trung bình của từng ảnh là bao nhiêu? Màu có phẳng không, và nếu không thì hệ số đang chạy dọc trục nào? Rồi đổi chiều rộng thành 5 và xem chuyện gì xảy ra.

# %%
B, C, H, W = 4, 3, 5, 4
x = np.ones((B, C, H, W))
coef = np.array([1.0, 2.0, 3.0, 4.0])
y = x * coef
print("shape của y:", y.shape, "| trung bình từng ảnh:", y.mean(axis=(1, 2, 3)))
try:
    np.ones((B, C, H, W + 1)) * coef
except ValueError as e:
    print("khi chiều rộng là 5:", e)

fig, ax = plt.subplots(figsize=(3.4, 3.0))
im = ax.imshow(y[0, 0], vmin=0, vmax=4)
fig.colorbar(im)
ax.set_title("ảnh 0, kênh 0: giá trị theo (hàng, cột)", fontsize=8)
plt.tight_layout()
plt.show()
