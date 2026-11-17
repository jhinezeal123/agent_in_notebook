# %% [markdown]
# **Vì sao cộng đường tắt (shortcut)? Nhìn tín hiệu đi ngược qua 20 lớp.**
#
# Hai mạng 20 lớp, mỗi lớp một ma trận ngẫu nhiên $W$ rồi ReLU. Mạng **plain** chuyển $h_{l+1} = \operatorname{ReLU}(W h_l)$. Mạng **residual** chuyển $h_{l+1} = h_l + \operatorname{ReLU}(W h_l)$: giữ lại $h_l$ rồi cộng thêm. Hình dưới đẩy một vector gradient từ lớp cuối ngược về lớp đầu (backprop viết tay) và vẽ **độ lớn gradient ở từng lớp** (trục log). Hãy nhìn: ở lớp đầu tiên, gradient của mạng nào còn đủ lớn để cập nhật trọng số, và mạng nào gần như bằng 0? Đường tắt cộng $h_l$ vào đầu ra thì Jacobian của một lớp là gì, và vì sao nó chặn được hiện tượng gradient biến mất?

# %%
import numpy as np
import matplotlib.pyplot as plt

rng = np.random.default_rng(0)
D, L, gain = 64, 20, 0.6


def grad_norms(residual):
    x = rng.normal(size=D)
    Ws, masks = [], []
    for _ in range(L):
        W = rng.normal(size=(D, D)) * gain / np.sqrt(D)
        h = W @ x
        Ws.append(W)
        masks.append((h > 0).astype(float))
        x = x + h * masks[-1] if residual else h * masks[-1]
    g = rng.normal(size=D)
    norms = [np.linalg.norm(g)]
    for W, m in zip(Ws[::-1], masks[::-1]):
        back = W.T @ (g * m)
        g = g + back if residual else back
        norms.append(np.linalg.norm(g))
    return norms[::-1]  # norms[l]: gradient tại đầu vào của lớp l (l = 0 là lớp đầu, l = L là lớp cuối)


fig, ax = plt.subplots(figsize=(5.4, 3.5))
ax.semilogy(grad_norms(False), "o-", ms=3, label="plain")
ax.semilogy(grad_norms(True), "s-", ms=3, label="có đường tắt (residual)")
ax.set_xlabel("lớp (0 = đầu, 20 = cuối)"); ax.set_ylabel("độ lớn gradient")
ax.legend(fontsize=8)
plt.tight_layout()
plt.show()

# %% [markdown]
# **ReLU trước hay sau phép cộng?** Lấy hai tín hiệu ngẫu nhiên $a$ (nhánh chính) và $b$ (đường tắt), mỗi cái là phân phối chuẩn. Hình trái: histogram của $\operatorname{ReLU}(a) + b$ (ReLU đặt **trước** phép cộng). Hình phải: histogram của $\operatorname{ReLU}(a + b)$ (ReLU đặt **sau**). Nhìn nhánh nào có giá trị âm, rồi tự trả lời: khối kế tiếp, vốn đứng sau một ReLU, quen nhận đầu vào thế nào, và khối kế tiếp có "thấy" được phần âm của đường tắt không nếu đầu ra của khối này đã bị cắt ở 0 trên từng nhánh?

# %%
a = rng.normal(size=20000)
b = rng.normal(size=20000)
fig, ax = plt.subplots(1, 2, figsize=(8.6, 3.2), sharey=True)
ax[0].hist(np.maximum(a, 0) + b, bins=60, color="tab:orange")
ax[0].set_title("ReLU(a) + b: ReLU trước phép cộng", fontsize=9)
ax[1].hist(np.maximum(a + b, 0), bins=60, color="tab:blue")
ax[1].set_title("ReLU(a + b): ReLU sau phép cộng", fontsize=9)
for axis in ax:
    axis.axvline(0, color="k", lw=0.8)
    axis.set_xlabel("giá trị")
ax[0].set_ylabel("số lượng")
plt.tight_layout()
plt.show()

# %% [markdown]
# **Khi nào hai nhánh cùng shape?** Một khối giữ nguyên số kênh và độ phân giải: nhánh chính có shape $(C, H, W) \to (C, H, W)$, đường tắt chỉ việc truyền $x$ qua. Một khối đổi số kênh từ 4 lên 8 và giảm độ phân giải từ $8 \times 8$ xuống $4 \times 4$: nhánh chính ra $(8, 4, 4)$, còn $x$ vẫn là $(4, 8, 8)$. Hình dưới vẽ hai trường hợp (chiều rộng hộp là số kênh, chiều cao là cạnh ảnh). Hãy tự trả lời: ở trường hợp thứ hai cần biến $x$ thành shape nào trước khi cộng, và cần ít nhất bao nhiêu phép toán đơn giản để làm được việc đó (nghĩ tới kernel 1×1 và stride)?

# %%
fig, ax = plt.subplots(1, 2, figsize=(8.6, 3.0))
cases = [("giữ nguyên", (4, 8), (4, 8)), ("đổi kênh và giảm độ phân giải", (4, 8), (8, 4))]
for axis, (title, (c0, s0), (c1, s1)) in zip(ax, cases):
    axis.add_patch(plt.Rectangle((0, 0), c0, s0, fill=False, ec="tab:green", lw=2))
    axis.text(c0 / 2, s0 + 0.4, f"x: {c0} kênh, {s0}×{s0}", ha="center", fontsize=8, color="tab:green")
    axis.add_patch(plt.Rectangle((6, 0), c1, s1, fill=False, ec="tab:red", lw=2))
    axis.text(6 + c1 / 2, s1 + 0.4, f"F(x): {c1} kênh, {s1}×{s1}", ha="center", fontsize=8, color="tab:red")
    axis.set_xlim(-1, 15); axis.set_ylim(-1, 10); axis.set_aspect("equal"); axis.axis("off")
    axis.set_title(title, fontsize=9)
plt.tight_layout()
plt.show()
