# %% [markdown]
# **Patch nhỏ hơn đắt hơn bao nhiêu?** Số token tăng theo $N = (H/P)^2$, nhưng "chi phí" có hai phần khác nhau. Mỗi khối encoder xử lý $N$ token với độ rộng $D$:
#
# - phần **tuyến tính theo N**: chiếu q, k, v và đầu ra của attention ($4D^2$ mỗi token) cùng MLP hai lớp với hệ số 4 ($8D^2$ mỗi token): tổng $12 D^2 N$ phép nhân-cộng;
# - phần **bậc hai theo N**: tính điểm attention và trộn value, $2 N^2 D$ phép nhân-cộng.
#
# Hình dưới vẽ **tỷ lệ của phần bậc hai** trong tổng chi phí một khối, theo $N$ (thang log), cho ba độ rộng $D$. Đường đứng đánh dấu $N = 16$ và $N = 49$ (hai mô hình của thí nghiệm này, $D = 64$) và $N = 196$ (ViT-B/16 trên ảnh $224 \times 224$, $D = 768$).
#
# Đoán trước khi nhìn số liệu thật: ở $D = 64$, $N = 49$ so với $N = 16$ thì thời gian của mô hình patch nhỏ hơn mô hình patch lớn gần 3 lần (tỷ lệ số token) hay gần 9 lần (tỷ lệ $N^2$)? Phần bậc hai chiếm bao nhiêu phần trăm chi phí ở hai điểm đó? Vì sao paper vẫn nói "bình phương"?

# %%
import numpy as np
import matplotlib.pyplot as plt

N = np.logspace(0, 3.2, 200)
fig, ax = plt.subplots(figsize=(7, 3.6))
for D, style in [(64, "-"), (256, "--"), (768, ":")]:
    linear = 12 * D * D * N
    quadratic = 2 * N * N * D
    ax.semilogx(N, 100 * quadratic / (linear + quadratic), style, label=f"D = {D}")
for n, label in [(16, "N = 16"), (49, "N = 49"), (196, "N = 196")]:
    ax.axvline(n, color="gray", lw=0.7)
    ax.text(n * 1.04, 3, label, fontsize=8, rotation=90)
ax.set_xlabel("số token N"); ax.set_ylabel("% chi phí là phần bậc hai (attention)")
ax.set_title("Khi nào N² thật sự chi phối chi phí một khối encoder", fontsize=9)
ax.legend(fontsize=8)
plt.tight_layout()
plt.show()
