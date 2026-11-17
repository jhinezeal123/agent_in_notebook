# %% [markdown]
# **Vì sao chồng 20, 56, 110 khối mà mạng vẫn "sống" được?** Hình trái chạy một thí nghiệm numpy nhỏ, chưa cần torch: một chồng $L$ khối, mỗi khối là $F(x) = W_2\,\mathrm{ReLU}(W_1 x)$ với $W$ ngẫu nhiên (độ rộng 32, không Batch Norm). Ta đo chuẩn của tín hiệu $\|x_L\|/\|x_0\|$ sau $L$ khối, cho hai kiểu khối:
#
# - **plain**: $x \leftarrow \mathrm{ReLU}(F(x))$;
# - **residual**: $x \leftarrow \mathrm{ReLU}(x + F(x))$ (đường tắt).
#
# và hai cỡ khởi tạo của $W$ (độ lệch chuẩn từng phần tử): *nhỏ* (0,05) và *cỡ He* ($\sqrt{2/32} \approx 0{,}25$, cỡ mà người ta chọn để giữ tín hiệu ổn định qua ReLU). Câu hỏi: kiểu khối nào chịu được khởi tạo nhỏ, kiểu nào đòi khởi tạo phải trúng, và điều đó nói gì về việc học "không làm gì" của một khối? (Mạng thật có Batch Norm lo phần co giãn; ở đây bỏ BN để thấy riêng tác dụng của đường tắt.)
#
# Hình phải: số tham số của mỗi stage (độ phân giải giảm một nửa, số kênh gấp đôi) trong mạng $n = 3$ ($6n+2 = 20$ lớp) và $n = 9$ (56 lớp), đếm bằng số học thuần túy (hai conv $3\times3$ mỗi khối, bỏ BN và đường tắt).

# %%
import numpy as np
import matplotlib.pyplot as plt

rng = np.random.default_rng(0)
d, L = 32, 30


def depth_curve(sigma, residual):
    x0 = np.abs(rng.standard_normal(d)) + 0.5
    x = x0.copy()
    out = [1.0]
    for _ in range(L):
        W1 = rng.standard_normal((d, d)) * sigma
        W2 = rng.standard_normal((d, d)) * sigma
        f = W2 @ np.maximum(W1 @ x, 0)
        x = np.maximum(x + f, 0) if residual else np.maximum(f, 0)
        out.append(np.linalg.norm(x) / np.linalg.norm(x0))
    return np.array(out)


fig, axes = plt.subplots(1, 2, figsize=(11, 3.6))
for sigma, name in [(0.05, "khởi tạo nhỏ (0,05)"), (np.sqrt(2 / d), "cỡ He (0,25)")]:
    for residual, style in [(False, "--"), (True, "-")]:
        axes[0].semilogy(depth_curve(sigma, residual), style, label=f"{'residual' if residual else 'plain'}, {name}")
axes[0].set_xlabel("số khối L"); axes[0].set_ylabel("‖x_L‖ / ‖x_0‖ (thang log)"); axes[0].legend(fontsize=7)
axes[0].set_title("Tín hiệu đi qua L khối", fontsize=9)

for n, colour in [(3, "tab:blue"), (9, "tab:orange")]:
    per_stage = [n * 2 * 9 * c * c for c in (16, 32, 64)]
    axes[1].bar(np.arange(3) + (0.2 if n == 9 else -0.2), per_stage, width=0.4, color=colour, label=f"n = {n} ({6 * n + 2} lớp)")
axes[1].set_xticks(range(3)); axes[1].set_xticklabels(["stage 1\n16 kênh, 32x32", "stage 2\n32 kênh, 16x16", "stage 3\n64 kênh, 8x8"], fontsize=8)
axes[1].set_ylabel("số tham số conv 3x3"); axes[1].legend(fontsize=8)
axes[1].set_title("Tham số conv theo stage", fontsize=9)
plt.tight_layout()
plt.show()
