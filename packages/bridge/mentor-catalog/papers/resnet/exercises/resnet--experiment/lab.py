# %% [markdown]
# **Degradation là chuyện của lỗi TRAIN, không phải lỗi test.** Trước khi train thật, hãy thấy hiện tượng trong một thí nghiệm numpy tí hon (chưa cần torch): phân loại hai nhánh xoắn ốc 2 chiều bằng mạng chồng nhiều lớp ReLU, độ rộng 16, train bằng gradient descent đơn giản. Ta so bốn mạng:
#
# - **plain 4 lớp** và **plain 30 lớp**: $h \leftarrow \mathrm{ReLU}(W h)$;
# - **residual 4 lớp** và **residual 30 lớp**: $h \leftarrow h + \mathrm{ReLU}(W h)$ (đường tắt).
#
# Hình đo **loss trên chính tập train** theo số bước. Câu hỏi: mạng sâu hơn có *nhiều khả năng biểu diễn hơn* mạng nông không? Vậy nếu loss train của plain 30 lớp cao hơn plain 4 lớp ở cùng số bước, đó là overfitting hay là chuyện khác? Mạng residual 30 lớp có gặp chuyện đó không? Đây là điều paper gọi là *degradation*, và là thứ bài thí nghiệm sắp hỏi bạn: so **lỗi train** của hai mạng, không chỉ lỗi test. (Đây là bản đồ chơi, và hiện tượng ở mạng 20 lớp thật nhẹ hơn nhiều.)

# %%
import numpy as np
import matplotlib.pyplot as plt

rng = np.random.default_rng(0)
n = 160
theta = np.sqrt(rng.uniform(0, 1, n // 2)) * 3 * np.pi
arm = np.c_[theta * np.cos(theta), theta * np.sin(theta)] / 10
X = np.r_[arm, -arm] + rng.normal(0, 0.02, (n, 2))
y = np.r_[np.zeros(n // 2), np.ones(n // 2)]


def train_curve(depth, residual, steps=500, lr=0.05, width=16, seed=0):
    g = np.random.default_rng(seed)
    w_in = g.standard_normal((2, width))
    scale = 0.1 if residual else 1.0
    Ws = [g.standard_normal((width, width)) * np.sqrt(2 / width) * scale for _ in range(depth)]
    w_out = g.standard_normal(width) / np.sqrt(width)
    losses = []
    for _ in range(steps):
        z0 = X @ w_in
        h = np.maximum(z0, 0)
        hs, zs = [h], []
        for W in Ws:
            z = h @ W
            zs.append(z)
            h = h + np.maximum(z, 0) if residual else np.maximum(z, 0)
            hs.append(h)
        logit = h @ w_out
        p = 1 / (1 + np.exp(-logit))
        losses.append(np.mean(np.logaddexp(0, logit) - y * logit))
        d_logit = (p - y) / n
        grad_out = hs[-1].T @ d_logit
        dh = d_logit[:, None] * w_out
        grads = [None] * depth
        for l in reversed(range(depth)):
            dz = dh * (zs[l] > 0)
            grads[l] = hs[l].T @ dz
            dh = dz @ Ws[l].T + (dh if residual else 0)
        for l in range(depth):
            Ws[l] -= lr * grads[l]
        w_in -= lr * (X.T @ (dh * (z0 > 0)))
        w_out -= lr * grad_out
    return losses


plt.figure(figsize=(7, 3.6))
for depth, residual, style in [(4, False, "b--"), (30, False, "b-"), (4, True, "r--"), (30, True, "r-")]:
    plt.plot(train_curve(depth, residual), style, label=f"{'residual' if residual else 'plain'} {depth} lớp")
plt.xlabel("bước gradient descent"); plt.ylabel("loss trên tập train"); plt.legend()
plt.title("Loss TRAIN theo bước: sâu hơn có tối ưu dễ hơn không?", fontsize=9)
plt.tight_layout()
plt.show()
