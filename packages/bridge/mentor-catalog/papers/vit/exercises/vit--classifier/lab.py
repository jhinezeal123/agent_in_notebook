# %% [markdown]
# **Patch size quyết định bao nhiêu token.** Hai hình trái: một chữ số 28 × 28 cắt thành lưới patch $4 \times 4$ và $7 \times 7$ (đường đỏ). Mỗi ô là một token của Transformer; thêm một token `cls` nữa. Hình phải: với ảnh 28 × 28 và ảnh 224 × 224 (cỡ ImageNet), số token $N = (H/P)^2$ theo patch size $P$ (thang log hai trục), và một ước lượng **chi phí của self-attention**: số phần tử của ma trận attention, $(N+1)^2$ mỗi head mỗi khối.
#
# Đọc hình trước khi code: patch 4 cho bao nhiêu token, patch 7 cho bao nhiêu (đếm ô)? Chi phí attention của hai cấu hình đó hơn kém nhau cỡ bao nhiêu lần? Và nếu ảnh to gấp đôi mỗi chiều mà vẫn dùng patch 4, đường chi phí nhảy lên bao nhiêu lần? Câu trả lời đó là lý do paper nói chi phí tăng "tỷ lệ nghịch với bình phương patch size" mà vẫn chấp nhận patch nhỏ khi cần.

# %%
import numpy as np
import matplotlib.pyplot as plt

digit = np.zeros((28, 28))  # một chữ "4" vẽ tay bằng ba nét
digit[4:17, 7:10] = 1
digit[14:17, 7:23] = 1
digit[4:25, 17:20] = 1

fig, axes = plt.subplots(1, 3, figsize=(11, 3.4), gridspec_kw={"width_ratios": [1, 1, 1.6]})
for ax, p in zip(axes[:2], [4, 7]):
    ax.imshow(digit, cmap="gray")
    for k in range(0, 29, p):
        ax.axhline(k - 0.5, color="tab:red", lw=0.7)
        ax.axvline(k - 0.5, color="tab:red", lw=0.7)
    ax.set_title(f"patch {p} x {p}", fontsize=9)
    ax.axis("off")

for img, style in [(28, "o-"), (224, "s--")]:
    valid = np.array([p for p in [1, 2, 4, 7, 8, 14, 16, 28, 32, 56, 112] if img % p == 0 and 1 < p < img])
    n = (img // valid) ** 2
    axes[2].loglog(valid, (n + 1) ** 2, style, label=f"ảnh {img}x{img}: (N+1)²")
    for p, nn_ in zip(valid, n):
        if img == 28 and p in (4, 7):
            axes[2].annotate(f"N = {nn_}", (p, (nn_ + 1) ** 2), textcoords="offset points", xytext=(6, 4), fontsize=8)
axes[2].set_xlabel("patch size P"); axes[2].set_ylabel("phần tử ma trận attention mỗi head, mỗi khối"); axes[2].legend(fontsize=8)
plt.tight_layout()
plt.show()
