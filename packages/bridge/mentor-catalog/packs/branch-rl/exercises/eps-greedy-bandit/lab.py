# %% [markdown]
# **Khám phá hay khai thác?** Bandit 10 tay: giá trị thật của mỗi tay là một số ngẫu nhiên (trung bình 0, độ lệch 1), mỗi lần kéo cho thưởng bằng giá trị thật cộng nhiễu. Bạn không thấy giá trị thật, chỉ thấy thưởng. Ô dưới chạy sẵn một máy mô phỏng (không phải hàm bạn sẽ viết) với ba mức epsilon, trung bình qua 300 bandit ngẫu nhiên khác nhau. Trước khi xem hình, đoán: `eps = 0` thắng ở đầu hay ở cuối? `eps = 0.1` thua ở đâu?

# %%
import numpy as np
import matplotlib.pyplot as plt

K, STEPS, RUNS = 10, 1000, 300
sim = np.random.default_rng(0)
true_q = sim.standard_normal((RUNS, K))
best_arm = true_q.argmax(axis=1)
rows = np.arange(RUNS)

curves = {}
for eps in (0.0, 0.01, 0.1):
    total = np.zeros((RUNS, K))
    count = np.zeros((RUNS, K))
    avg_reward = np.zeros(STEPS)
    optimal = np.zeros(STEPS)
    for t in range(STEPS):
        estimate = total / np.maximum(count, 1)
        greedy = (estimate + 1e-9 * sim.random((RUNS, K))).argmax(axis=1)
        explore = sim.random(RUNS) < eps
        arm = np.where(explore, sim.integers(K, size=RUNS), greedy)
        reward = true_q[rows, arm] + sim.standard_normal(RUNS)
        total[rows, arm] += reward
        count[rows, arm] += 1
        avg_reward[t] = reward.mean()
        optimal[t] = (arm == best_arm).mean()
    curves[eps] = (avg_reward, optimal)

fig, axes = plt.subplots(1, 2, figsize=(10, 3.4))
for eps, (avg_reward, optimal) in curves.items():
    axes[0].plot(avg_reward, label=f"eps = {eps}")
    axes[1].plot(100 * optimal, label=f"eps = {eps}")
axes[0].set_xlabel("bước")
axes[0].set_ylabel("thưởng trung bình")
axes[1].set_xlabel("bước")
axes[1].set_ylabel("% lần chọn đúng tay tốt nhất")
axes[0].legend()
plt.tight_layout()
plt.show()
for eps, (avg_reward, optimal) in curves.items():
    print(f"eps = {eps}: thưởng trung bình 100 bước cuối = {avg_reward[-100:].mean():.2f}, chọn đúng tay tốt nhất {100 * optimal[-100:].mean():.0f}%")

# %% [markdown]
# **Một ước lượng chạy thật.** Bên dưới là một tay duy nhất với thưởng thật 1.0 và nhiễu 1.0. Đường xanh là trung bình cộng của mọi thưởng đã thấy (tính lại từ đầu cho dễ vẽ); vùng mờ là độ không chắc chắn $\pm 1/\sqrt{n}$. Quan sát: lần kéo đầu tiên đổi ước lượng rất mạnh, lần thứ 100 gần như không đổi nó. Câu hỏi để mang vào bài: trong công thức cập nhật tăng dần, thứ gì trong đó làm một thưởng mới có trọng số nhỏ dần, và trọng số của thưởng thứ $n$ là bao nhiêu?

# %%
rewards = 1.0 + np.random.default_rng(3).standard_normal(200)
running = np.cumsum(rewards) / np.arange(1, 201)
steps = np.arange(1, 201)
fig, ax = plt.subplots(figsize=(7, 3))
ax.plot(steps, running, label="trung bình các thưởng đã thấy")
ax.fill_between(steps, 1 - 1 / np.sqrt(steps), 1 + 1 / np.sqrt(steps), alpha=0.2, label="thật ± 1/sqrt(n)")
ax.axhline(1.0, color="k", lw=0.8, ls="--")
ax.set_xlabel("số lần kéo n")
ax.set_ylabel("ước lượng Q")
ax.legend()
plt.tight_layout()
plt.show()

# %% [markdown]
# **Đồng hạng.** Lúc đầu mọi $Q = 0$: cả 10 tay cùng là "tốt nhất". Nếu code luôn lấy tay đầu tiên trong số đó, chuyện gì xảy ra với 9 tay còn lại khi thưởng của tay 0 hóa ra dương? Tự trả lời trước khi viết `select_action`.
