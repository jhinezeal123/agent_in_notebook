# %% [markdown]
# **Một rollout trông như thế nào?** Chạy một policy $T$ bước liên tục trong CartPole: gậy đổ thì reset và chơi tiếp, nên một rollout là **nhiều episode nối đuôi nhau**, và thường **cắt ngang một episode ở cuối**. Cell dưới dựng một CartPole tí hon chỉ để nhìn (bản chính thức được cho sẵn) và chạy 150 bước với policy ngẫu nhiên. Hình trên: góc gậy theo bước; đường đỏ đứng là chỗ episode kết thúc và môi trường được reset (góc nhảy về gần 0). Hình dưới: reward cộng dồn trong episode. Nhìn: những bước nào của rollout có "tương lai" sau chúng trong cùng episode, và những bước nào đứng cuối rollout mà episode còn dở? Với chúng, ta không biết phần thưởng còn lại: lấy ở đâu?

# %%
import math
import numpy as np
import matplotlib.pyplot as plt


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


rng = np.random.default_rng(3)
T = 150
s = rng.uniform(-0.05, 0.05, size=4)
states, ends, ep_ret, since = [], [], [], 0
for t_ in range(T):
    states.append(s.copy())
    s, done = cp_step(s, int(rng.integers(2)))
    since += 1
    ep_ret.append(since)
    if done:
        ends.append(t_)
        s, since = rng.uniform(-0.05, 0.05, size=4), 0
states = np.array(states)

fig, ax = plt.subplots(2, 1, figsize=(10, 4.6), sharex=True)
ax[0].plot(np.degrees(states[:, 2]), color="#4c78a8")
ax[1].plot(ep_ret, color="#59a14f")
for e in ends:
    for a in ax:
        a.axvline(e + 0.5, color="r", lw=1)
ax[0].set_ylabel("góc gậy (độ)")
ax[1].set_ylabel("reward cộng dồn\ntrong episode")
ax[1].set_xlabel(f"bước của rollout (T = {T}); đường đỏ: episode kết thúc, môi trường được reset")
plt.tight_layout()
plt.show()
print(f"{len(ends)} episode kết thúc trong {T} bước; episode cuối còn dở {since} bước khi rollout bị cắt.")

# %% [markdown]
# **Vì sao PPO xáo trộn dữ liệu của rollout trước khi học?** Hai bước liên tiếp của một rollout gần như **trùng nhau** (gậy chỉ nhích 0,02 giây), nên dữ liệu thu theo thứ tự thời gian là một chuỗi tương quan rất mạnh, khác xa mẫu độc lập mà gradient descent ngầm giả định. Hình trái: góc ở bước $t$ so với góc ở bước $t+1$ (nằm sát đường chéo). Hình phải: góc ở bước $t$ so với góc ở một bước **ngẫu nhiên** của cùng rollout (tản ra). Bài `ppo-update` của bạn đã xáo thứ tự bằng `generator`; bài này giữ nguyên thứ tự thời gian vì GAE cần nó, nên **không được xáo ở bước thu thập**.

# %%
th = np.degrees(states[:, 2])
fig, ax = plt.subplots(1, 2, figsize=(9, 3.6))
ax[0].scatter(th[:-1], th[1:], s=8, color="#4c78a8")
ax[0].set_xlabel("góc ở bước t (độ)")
ax[0].set_ylabel("góc ở bước t + 1")
perm = rng.permutation(T)
ax[1].scatter(th, th[perm], s=8, color="#f28e2b")
ax[1].set_xlabel("góc ở bước t (độ)")
ax[1].set_ylabel("góc ở một bước ngẫu nhiên")
plt.tight_layout()
plt.show()
