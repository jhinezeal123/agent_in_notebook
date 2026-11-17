# %% [markdown]
# **Loss "đoán nhiễu" lớn hay nhỏ, và ở đâu?** Trước khi train, hãy có một thước đo. Hình dưới dùng ảnh đồ chơi giống chữ số (hai nét thẳng trắng trên nền đen, 32 × 32, giá trị $-1$ hoặc $+1$) và lịch nhiễu của thí nghiệm ($T = 200$, $\beta$ từ $5\cdot10^{-4}$ đến $0{,}1$). Với ba bộ đoán nhiễu *không cần học*, ta đo sai số $\|\varepsilon - \hat\varepsilon\|^2$ trung bình theo pixel tại từng bước $t$:
#
# 1. **đoán 0**: $\hat\varepsilon = 0$;
# 2. **giả sử ảnh toàn nền** ($\hat x_0 = -1$ ở mọi pixel), rồi suy $\hat\varepsilon$ từ $x_t = \sqrt{\bar\alpha_t}\,x_0 + \sqrt{1-\bar\alpha_t}\,\varepsilon$;
# 3. **làm mờ cục bộ**: lấy $\hat x_0$ là $x_t / \sqrt{\bar\alpha_t}$ làm mờ trung bình 3 × 3 rồi cắt về $[-1, 1]$, suy $\hat\varepsilon$ như trên.
#
# Hình trái: sai số theo $t$ (thang log). Hình phải: một ảnh ở bốn bước $t$ khác nhau. Câu hỏi: bộ đoán nào thắng "đoán 0" ở $t$ lớn, bộ nào thua nặng ở $t$ nhỏ, và vì sao? Con số trong ngoặc ở chú thích là trung bình **đều** theo $t$, chính là dạng của $L_	ext{simple}$: bộ nào có trung bình dưới 1? Mạng đã học phải làm tốt ở **cả hai đầu** của trục $t$ để đạt ngưỡng của đề (cỡ vài phần trăm).

# %%
import numpy as np
import matplotlib.pyplot as plt

rng = np.random.default_rng(0)
S = 32
yy, xx = np.mgrid[0:S, 0:S]


def stroke_image():
    img = np.full((S, S), -1.0)
    for _ in range(2):
        (x1, y1), (x2, y2) = rng.uniform(6, 26, (2, 2))
        d = np.array([x2 - x1, y2 - y1])
        u = np.clip(((xx - x1) * d[0] + (yy - y1) * d[1]) / max((d ** 2).sum(), 1e-6), 0, 1)
        img[np.hypot(xx - (x1 + u * d[0]), yy - (y1 + u * d[1])) < 1.6] = 1.0
    return img


def blur3(a):
    p = np.pad(a, ((0, 0), (1, 1), (1, 1)), mode="edge")
    return sum(p[:, i:i + S, j:j + S] for i in range(3) for j in range(3)) / 9.0


x0 = np.stack([stroke_image() for _ in range(96)])
ab = np.cumprod(1 - np.linspace(5e-4, 0.1, 200))

steps = np.arange(0, 200, 4)
curves = {"đoán 0": [], "giả sử ảnh toàn nền": [], "làm mờ 3 × 3": []}
for t in steps:
    s, sg = np.sqrt(ab[t]), np.sqrt(1 - ab[t])
    eps = rng.standard_normal(x0.shape)
    xt = s * x0 + sg * eps
    guesses = {
        "đoán 0": np.zeros_like(eps),
        "giả sử ảnh toàn nền": (xt + s) / sg,
        "làm mờ 3 × 3": (xt - s * np.clip(blur3(xt / s), -1, 1)) / sg,
    }
    for name, g in guesses.items():
        curves[name].append(np.mean((g - eps) ** 2))

fig, axes = plt.subplots(1, 5, figsize=(12, 3), gridspec_kw={"width_ratios": [3.2, 1, 1, 1, 1]})
for name, v in curves.items():
    axes[0].semilogy(steps, np.maximum(v, 1e-5), label=f"{name} (trung bình {np.mean(v):.3f})")
axes[0].set_xlabel("bước t"); axes[0].set_ylabel("sai số ‖ε − ε̂‖² theo pixel"); axes[0].legend(fontsize=7)
for a, t in zip(axes[1:], [10, 50, 100, 199]):
    a.imshow(np.sqrt(ab[t]) * x0[0] + np.sqrt(1 - ab[t]) * rng.standard_normal((S, S)), cmap="gray", vmin=-3, vmax=3)
    a.set_title(f"t = {t}", fontsize=8); a.axis("off")
plt.tight_layout()
plt.show()
