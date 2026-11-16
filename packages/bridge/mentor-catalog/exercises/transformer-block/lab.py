# %% [markdown]
# **Residual stream.** Hãy hình dung mỗi token mang một vector chạy thẳng từ dưới lên trên (đường xanh đậm). Mỗi sublayer (attention, FFN) chỉ **đọc** một bản đã chuẩn hoá của dòng đó và **cộng thêm** một phần vào. Đó là pre-LN.
#
# Bài báo gốc (post-LN) thì đặt LayerNorm **trên chính dòng chảy**, sau mỗi phép cộng. So hai sơ đồ: ở bên nào thì có một đường đi thẳng từ input tới output không qua phép biến đổi nào?

# %%
import numpy as np
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch

def box(ax, x, y, text, color):
    ax.add_patch(FancyBboxPatch((x - 0.9, y - 0.28), 1.8, 0.56, boxstyle="round,pad=0.05", fc=color, ec="k"))
    ax.text(x, y, text, ha="center", va="center", fontsize=10)

def plus(ax, x, y):
    ax.add_patch(plt.Circle((x, y), 0.2, fc="white", ec="k"))
    ax.text(x, y, "+", ha="center", va="center", fontsize=13)

def arrow(ax, a, b, color="k", lw=1.2):
    ax.annotate("", xy=b, xytext=a, arrowprops=dict(arrowstyle="->", color=color, lw=lw))

fig, axes = plt.subplots(1, 2, figsize=(11, 6.5))
stream = "#1f4e9c"
for ax, title in zip(axes, ["pre-LN (bài này)", "post-LN (bài báo gốc)"]):
    ax.set_xlim(-2.5, 3.5)
    ax.set_ylim(-0.5, 8.6)
    ax.axis("off")
    ax.set_title(title)
    ax.text(0, -0.25, "x", ha="center", fontsize=12)
    ax.text(0, 8.45, "y", ha="center", fontsize=12)

ax = axes[0]
arrow(ax, (0, 0), (0, 3.3), stream, 3)
arrow(ax, (0, 3.7), (0, 7.3), stream, 3)
arrow(ax, (0, 7.7), (0, 8.3), stream, 3)
plus(ax, 0, 3.5)
plus(ax, 0, 7.5)
for y0, ln, sub, col in [(0.6, "LN₁", "MHA", "#fdd0a2"), (4.4, "LN₂", "FFN", "#c7e9c0")]:
    arrow(ax, (0, y0), (2, y0 + 0.35))
    box(ax, 2, y0 + 0.65, ln, "#dadaeb")
    arrow(ax, (2, y0 + 0.93), (2, y0 + 1.55))
    box(ax, 2, y0 + 1.85, sub, col)
    arrow(ax, (2, y0 + 2.13), (0.2, y0 + 2.9))

ax = axes[1]
arrow(ax, (0, 0), (0, 2.3), stream, 3)
plus(ax, 0, 2.5)
arrow(ax, (0, 2.7), (0, 3.1), stream, 3)
box(ax, 0, 3.4, "LN₁", "#dadaeb")
arrow(ax, (0, 3.7), (0, 6.3), stream, 3)
plus(ax, 0, 6.5)
arrow(ax, (0, 6.7), (0, 7.1), stream, 3)
box(ax, 0, 7.4, "LN₂", "#dadaeb")
arrow(ax, (0, 7.7), (0, 8.3), stream, 3)
for y0, sub, col in [(0.4, "MHA", "#fdd0a2"), (4.4, "FFN", "#c7e9c0")]:
    arrow(ax, (0, y0), (2, y0 + 0.6))
    box(ax, 2, y0 + 0.9, sub, col)
    arrow(ax, (2, y0 + 1.18), (0.2, y0 + 2.0))
plt.tight_layout()
plt.show()

# %% [markdown]
# **Thí nghiệm: chồng 24 block.** Thay mỗi sublayer bằng một hàm ngẫu nhiên `tanh(· @ M)` (đủ để thấy dòng chảy). Ta đo hai thứ sau mỗi block: chuẩn của residual stream, và output còn **giống input** bao nhiêu (cosine giữa vector của token ở output và ở input).
#
# Pre-LN: dòng chảy lớn dần (mỗi block cộng thêm, không gì chuẩn hoá lại), nhưng input vẫn nằm trong tổng nhờ đường đi thẳng, cosine chỉ giảm chậm. Post-LN: dòng chảy bị chuẩn hoá lại sau mỗi phép cộng, input bị "rửa trôi" sau vài block. Đường đi thẳng đó cũng là đường gradient đi về các lớp đầu: đó là lý do pre-LN train ổn định hơn ở mạng sâu.

# %%
rng = np.random.default_rng(0)
D, L = 64, 24
mats = [rng.normal(size=(D, D)) / np.sqrt(D) for _ in range(2 * L)]

def norm_tokens(u):
    return (u - u.mean(-1, keepdims=True)) / np.sqrt(u.var(-1, keepdims=True) + 1e-5)

def sublayer(x, M, pre):
    # một "sublayer" giả: tanh(· @ M); pre-LN đọc bản chuẩn hoá, post-LN chuẩn hoá sau phép cộng
    return x + np.tanh(norm_tokens(x) @ M) if pre else norm_tokens(x + np.tanh(x @ M))

x0 = rng.normal(size=(8, D))
fig, ax = plt.subplots(1, 2, figsize=(11, 3.4))
for pre, name in [(True, "pre-LN"), (False, "post-LN")]:
    x = x0.copy()
    norms, cosine = [], []
    for l in range(L):
        for M in mats[2 * l:2 * l + 2]:
            x = sublayer(x, M, pre)
        norms.append(np.linalg.norm(x) / np.sqrt(x.size))
        cos = (x * x0).sum(-1) / (np.linalg.norm(x, axis=-1) * np.linalg.norm(x0, axis=-1))
        cosine.append(cos.mean())
    ax[0].plot(range(1, L + 1), norms, "o-", ms=3, label=name)
    ax[1].plot(range(1, L + 1), cosine, "o-", ms=3, label=name)
ax[0].set_title("chuẩn RMS của residual stream")
ax[1].set_title("cosine(output, input): input còn lại bao nhiêu")
ax[1].axhline(0, color="gray", lw=0.5)
for a in ax:
    a.set_xlabel("số block")
    a.legend()
plt.tight_layout()
plt.show()

# %% [markdown]
# **GELU.** Một ReLU "mềm": $x\,\Phi(x)$ với $\Phi$ là CDF của chuẩn tắc. Hình dưới vẽ bản chính xác (qua `erf`) cạnh ReLU. Bài này yêu cầu **bản xấp xỉ tanh** trong đề (GPT-2 dùng bản đó): viết xong, hãy vẽ phần chênh lệch của nó so với bản `erf` — lớn cỡ bao nhiêu?

# %%
from math import erf

z = np.linspace(-4, 4, 400)
gelu_erf = z * 0.5 * (1 + np.vectorize(erf)(z / np.sqrt(2)))
plt.figure(figsize=(6, 3.4))
plt.plot(z, np.maximum(z, 0), label="ReLU")
plt.plot(z, gelu_erf, label="GELU (erf, chính xác)")
plt.axhline(0, color="gray", lw=0.5)
plt.legend()
plt.title("GELU âm nhẹ ở x < 0 và trơn tại 0")
plt.show()

# %% [markdown]
# **Bảng shape** (B batch, T token, D model, F ẩn của FFN, thường F = 4D). Chú ý: chỉ attention trộn thông tin **giữa các token**; LN và FFN xử lý từng token riêng.

# %%
rows = [
    ("x, h, y", "(B, T, D)"),
    ("LN: mean/var theo trục", "D (trục cuối)"),
    ("MHA weights", "(B, H, T, T)"),
    ("u @ W1 + b1", "(B, T, F)"),
    ("FFN(u)", "(B, T, D)"),
]
for name, shape in rows:
    print(f"{name:>24}: {shape}")
