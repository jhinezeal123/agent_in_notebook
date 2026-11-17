# %% [markdown]
# **Vì sao một rollout được dùng nhiều epoch, và chuyện gì xảy ra nếu không có cái "phanh"?** Thu thập dữ liệu rất tốn kém, nên PPO muốn học nhiều bước từ cùng một rollout. Nhưng mỗi bước cập nhật làm policy rời khỏi policy đã sinh dữ liệu, và dữ liệu cũ càng lúc càng kém đại diện. Hình dưới là một đồ chơi: policy hai hành động $\pi_\theta(a{=}1) = \sigma(\theta)$, rollout 256 mẫu thu ở $\theta_{\text{old}} = 0$, advantage dương hơn ở $a=1$. Ta chỉ **leo gradient thẳng** trên $\frac1N\sum_t r_t A_t$ (không cắt gì cả) qua nhiều epoch và theo dõi ba con số ($r_t = \pi_\theta/\pi_{\text{old}}$): tỉ số trung bình của các mẫu có $a=1$, tỉ lệ mẫu có $|r - 1| > 0.2$ (**clip_fraction**), và $\text{approx\_kl} = \operatorname{mean}(\text{old\_logp} - \text{new\_logp})$. Trước khi xem: đoán các số đó có ngừng tăng sau một lúc không? Và nếu bạn chỉ có thể nhìn một con số để quyết định "dừng cập nhật rollout này", bạn chọn số nào?

# %%
import numpy as np
import matplotlib.pyplot as plt

gen = np.random.default_rng(0)
n = 256
a = gen.integers(0, 2, size=n)
adv = (a == 1) * 1.0 - 0.4 + 0.5 * gen.standard_normal(n)
sigma = lambda x: 1.0 / (1.0 + np.exp(-x))
old_logp = np.log(np.full(n, 0.5))

theta, lr, epochs = 0.0, 0.5, 40
ratio_a1, clip_frac, kl = [], [], []
for _ in range(epochs):
    p1 = sigma(theta)
    new_logp = np.where(a == 1, np.log(p1), np.log(1 - p1))
    r = np.exp(new_logp - old_logp)
    ratio_a1.append(r[a == 1].mean())
    clip_frac.append((np.abs(r - 1) > 0.2).mean())
    kl.append((old_logp - new_logp).mean())
    theta += lr * np.mean(r * adv * (a - p1))

fig, axes = plt.subplots(1, 3, figsize=(11, 3.2))
for ax, ys, name in zip(axes, [ratio_a1, clip_frac, kl], ["tỉ số trung bình (a = 1)", "clip_fraction", "approx_kl"]):
    ax.plot(range(epochs), ys)
    ax.set_xlabel("epoch")
    ax.set_title(name)
axes[0].axhline(1.2, color="red", lw=1, ls="--")
plt.tight_layout()
plt.show()
print(f"sau {epochs} epoch: tỉ số a=1 = {ratio_a1[-1]:.2f}, clip_fraction = {clip_frac[-1]:.2f}, approx_kl = {kl[-1]:.3f}")

# %% [markdown]
# **Lịch trình epoch x minibatch.** Mỗi epoch xáo trộn lại $N$ mẫu rồi chia thành các minibatch; mỗi minibatch là **một** lần cập nhật. Hình dưới là lịch của $N = 10$, `minibatch_size = 4`, 3 epoch: mỗi hàng là một lần cập nhật (`optimizer.step()`), ô tô màu là mẫu được dùng ở lần đó. Quan sát và đếm: tổng số lần cập nhật, mỗi mẫu xuất hiện mấy lần trong một epoch và qua cả ba epoch, minibatch cuối của mỗi epoch có gì khác, và nếu bạn quên xáo trộn lại giữa các epoch thì hình sẽ khác ở đâu?

# %%
N, mb, E = 10, 4, 3
sched = np.random.default_rng(3)
rows, labels = [], []
for e in range(E):
    perm = sched.permutation(N)
    for i in range(0, N, mb):
        row = np.zeros(N)
        row[perm[i:i + mb]] = e + 1
        rows.append(row)
        labels.append(f"epoch {e + 1}")
grid = np.array(rows)

fig, ax = plt.subplots(figsize=(6.2, 4.2))
ax.imshow(np.ma.masked_equal(grid, 0), cmap="viridis", vmin=0.5, vmax=E + 0.5, aspect="auto")
ax.set_xticks(range(N))
ax.set_xlabel("chỉ số mẫu")
ax.set_yticks(range(len(labels)))
ax.set_yticklabels([f"{i + 1}  ({lab})" for i, lab in enumerate(labels)], fontsize=8)
ax.set_ylabel("lần cập nhật (optimizer.step)")
plt.tight_layout()
plt.show()
print("tổng số lần cập nhật:", len(rows))
