# %% [markdown]
# **Vì sao có residual và LayerNorm quanh mỗi sublayer (§3.1).** Mô phỏng 12 sublayer xếp chồng, mỗi sublayer là một phép nhân với ma trận ngẫu nhiên $W$ (cỡ vừa đủ để $f(x)$ có độ lệch chuẩn bằng $x$). Chỉ cộng residual $x + f(x)$ thì phương sai nhân đôi qua mỗi lớp, độ lớn nổ theo cấp số nhân. Thêm LayerNorm sau mỗi phép cộng thì mọi lớp nhận đầu vào cỡ 1, dù xếp bao nhiêu lớp.
#
# **Vì sao cần hàm kích hoạt giữa hai Linear của FFN (Eq. 2).** Không có $\max(0,\cdot)$, hai phép tuyến tính liên tiếp chỉ là một phép tuyến tính. Hình phải: số hạng ẩn trước và sau ReLU; một nửa số hạng bị cắt về 0, và đó là chỗ mạng "tự chọn" nó dùng nơ-ron nào.

# %%
import torch
import torch.nn.functional as F
import matplotlib.pyplot as plt

torch.manual_seed(0)
d, depth = 64, 12
x0 = torch.randn(256, d)
mats = [torch.randn(d, d) / d ** 0.5 for _ in range(depth)]

plain, normed = [x0], [x0]
for W in mats:
    plain.append(plain[-1] + plain[-1] @ W)
    normed.append(F.layer_norm(normed[-1] + normed[-1] @ W, (d,)))

W1 = torch.randn(d, 4 * d) / d ** 0.5
W2 = torch.randn(4 * d, d) / (4 * d) ** 0.5
h = x0 @ W1
collapsed = ((x0 @ W1) @ W2 - x0 @ (W1 @ W2)).abs().max()
print(f"hai Linear liên tiếp, không có ReLU, khác một Linear gộp bao nhiêu? {collapsed:.1e}")

fig, ax = plt.subplots(1, 2, figsize=(10, 3.2))
ax[0].plot([float(p.std()) for p in plain], "o-", label="chỉ residual: x + f(x)")
ax[0].plot([float(p.std()) for p in normed], "o-", label="residual rồi LayerNorm")
ax[0].set_yscale("log"); ax[0].set_xlabel("số sublayer đã xếp"); ax[0].set_ylabel("độ lệch chuẩn của x"); ax[0].legend(fontsize=8)
ax[1].hist(h.flatten().numpy(), bins=60, alpha=0.6, label="trước ReLU")
ax[1].hist(torch.relu(h).flatten().numpy(), bins=60, alpha=0.6, label="sau ReLU")
ax[1].set_xlabel("giá trị lớp ẩn của FFN (d_ff = 4·d_model)"); ax[1].legend(fontsize=8)
plt.tight_layout()
plt.show()
