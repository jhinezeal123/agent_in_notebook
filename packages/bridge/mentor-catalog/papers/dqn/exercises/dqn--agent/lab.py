# %% [markdown]
# **CartPole trông như thế nào, và "điểm" nghĩa là gì?** Mỗi bước gậy còn đứng cho 1 điểm; gậy nghiêng quá 12 độ (hoặc xe ra khỏi đường ray) thì hết episode; sống đủ 200 bước thì dừng (bị cắt, không phải thất bại). Cell dưới dựng một CartPole tí hon chỉ để nhìn (bản chính thức sẽ được cho sẵn ở bài thí nghiệm) và so hai "agent" chưa biết học gì: một agent **chọn hành động ngẫu nhiên**, một agent theo **luật tay** "đẩy xe về phía gậy đang nghiêng, cộng thêm vận tốc góc". Hình trái: phân bố return của 200 episode ngẫu nhiên. Hình phải: góc gậy theo thời gian của hai agent trong một episode.

# %%
import math
import numpy as np
import matplotlib.pyplot as plt


def cp_reset(rng):
    return rng.uniform(-0.05, 0.05, size=4)


def cp_step(s, a):
    x, x_dot, th, th_dot = s
    force = 10.0 if a == 1 else -10.0
    cos, sin = math.cos(th), math.sin(th)
    temp = (force + 0.05 * th_dot ** 2 * sin) / 1.1
    th_acc = (9.8 * sin - cos * temp) / (0.5 * (4.0 / 3.0 - 0.1 * cos ** 2 / 1.1))
    x_acc = temp - 0.05 * th_acc * cos / 1.1
    s2 = np.array([x + 0.02 * x_dot, x_dot + 0.02 * x_acc, th + 0.02 * th_dot, th_dot + 0.02 * th_acc])
    done = abs(s2[0]) > 2.4 or abs(s2[2]) > 12 * 2 * math.pi / 360
    return s2, done


def run(policy, seed, max_steps=200):
    rng = np.random.default_rng(seed)
    s = cp_reset(rng)
    angles = [s[2]]
    for _ in range(max_steps):
        s, done = cp_step(s, policy(s, rng))
        angles.append(s[2])
        if done:
            break
    return len(angles) - 1, np.array(angles)


random_policy = lambda s, rng: int(rng.integers(2))
heuristic = lambda s, rng: int(s[2] + 0.5 * s[3] + 0.1 * s[1] + 0.05 * s[0] > 0)

rand_returns = [run(random_policy, seed)[0] for seed in range(200)]
fig, ax = plt.subplots(1, 2, figsize=(10, 3.4))
ax[0].hist(rand_returns, bins=range(5, 60, 2), color="#4c78a8")
ax[0].axvline(np.mean(rand_returns), color="k", ls="--", label=f"trung bình {np.mean(rand_returns):.1f}")
ax[0].set_xlabel("return của một episode (số bước gậy còn đứng)")
ax[0].set_ylabel("số episode (trên 200)")
ax[0].legend()
for name, policy in [("ngẫu nhiên", random_policy), ("luật tay", heuristic)]:
    n, angles = run(policy, 0)
    ax[1].plot(np.degrees(angles), label=f"{name}: {n} bước")
ax[1].axhline(12, color="r", ls=":")
ax[1].axhline(-12, color="r", ls=":")
ax[1].set_xlabel("bước")
ax[1].set_ylabel("góc gậy (độ); đỏ: giới hạn 12 độ")
ax[1].legend()
plt.tight_layout()
plt.show()

# %% [markdown]
# **Vì sao Q-value có một "trần"?** DQN học $Q(s,a)$: tổng thưởng chiết khấu về sau, $\sum_k \gamma^k r_{t+k}$. Ở CartPole mỗi bước thưởng 1, nên nếu gậy đứng mãi thì $Q = 1 + \gamma + \gamma^2 + \dots = 1/(1-\gamma)$. Hình trái: trọng số $\gamma^k$ của thưởng cách $k$ bước, cho ba giá trị $\gamma$; đường đứng là độ dài tối đa 200 bước của một episode. Hình phải: một chi tiết dễ làm sai im lặng. Episode bị **cắt** ở bước 200 không phải vì thất bại, nhưng nếu bạn coi bước cuối là "kết thúc" (cờ `done`) thì mục tiêu TD của các trạng thái gần bước 200 bị hạ thấp: đường đỏ là Q "thật" của một agent chơi hoàn hảo, đường xanh là Q mà một cờ `done` nhầm ở bước 200 sẽ dạy. Hãy nhìn khoảng cách hai đường ở bước 150 và nghĩ xem mạng sẽ học gì.

# %%
fig, ax = plt.subplots(1, 2, figsize=(10, 3.4))
k = np.arange(0, 400)
for gamma in [0.9, 0.99, 0.999]:
    ax[0].plot(k, gamma ** k, label=f"gamma = {gamma}")
ax[0].axvline(200, color="gray", ls=":")
ax[0].set_xlabel("k (bước về sau)")
ax[0].set_ylabel("trọng số gamma^k")
ax[0].legend()
gamma = 0.99
t_ = np.arange(200)
true_q = np.full(200, 1 / (1 - gamma))
cut_q = (1 - gamma ** (200 - t_)) / (1 - gamma)
ax[1].plot(t_, true_q, "r", label="Q thật: agent còn chơi tiếp mãi")
ax[1].plot(t_, cut_q, "b", label="Q khi coi bước 200 là kết thúc")
ax[1].set_xlabel("bước trong episode")
ax[1].set_ylabel("Q của trạng thái tốt")
ax[1].legend()
plt.tight_layout()
plt.show()
