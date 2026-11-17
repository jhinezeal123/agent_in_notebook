import math

# CartPole thuần NumPy (không cần cài gym). Một xe trượt trên đường ray, trên xe có một cây gậy dựng đứng; mỗi bước bạn đẩy xe sang
# trái (hành động 0) hoặc sang phải (hành động 1) với lực cố định. Mỗi bước gậy còn đứng được thưởng 1 điểm.
#   obs = [vị trí xe, vận tốc xe, góc gậy (radian, 0 là đứng thẳng), vận tốc góc]
#   Episode kết thúc (done = True) khi |vị trí| > 2,4 hoặc |góc| > 12 độ; bị cắt (truncated = True) khi sống đủ MAX_STEPS = 200 bước.
# Return tối đa của một episode là 200; chọn hành động ngẫu nhiên thì trung bình chỉ khoảng 20.
OBS_DIM = 4
N_ACTIONS = 2
MAX_STEPS = 200


class CartPole:
    """Môi trường CartPole (vật lý chuẩn của gym: trọng lực 9,8; xe nặng 1; gậy nặng 0,1, nửa dài 0,5; lực 10; bước thời gian 0,02 s, tích phân Euler).
    reset(seed=None) -> obs: trạng thái đầu, mỗi thành phần ngẫu nhiên trong [-0,05; 0,05]. Có seed thì tái lập được; không có thì dùng tiếp dòng ngẫu nhiên đang có.
    step(action) -> (obs, reward, done, truncated): obs float32 shape (4,); reward luôn là 1.0; done là bool "gậy đổ hoặc xe ra khỏi ray" (kết thúc thật);
    truncated là bool "đã đủ MAX_STEPS bước" (bị cắt, không phải thất bại). Sau khi done hoặc truncated, phải gọi reset() lại."""

    gravity = 9.8
    mass_cart = 1.0
    mass_pole = 0.1
    half_length = 0.5
    force_mag = 10.0
    tau = 0.02
    theta_limit = 12 * 2 * math.pi / 360
    x_limit = 2.4

    def __init__(self):
        self._rng = np.random.default_rng()
        self.state = None
        self.steps = 0

    def reset(self, seed=None):
        if seed is not None:
            self._rng = np.random.default_rng(seed)
        self.state = self._rng.uniform(-0.05, 0.05, size=4)
        self.steps = 0
        return self.state.astype(np.float32)

    def step(self, action):
        x, x_dot, theta, theta_dot = self.state
        force = self.force_mag if int(action) == 1 else -self.force_mag
        total_mass = self.mass_cart + self.mass_pole
        pole_mass_length = self.mass_pole * self.half_length
        cos, sin = math.cos(theta), math.sin(theta)
        temp = (force + pole_mass_length * theta_dot ** 2 * sin) / total_mass
        theta_acc = (self.gravity * sin - cos * temp) / (self.half_length * (4.0 / 3.0 - self.mass_pole * cos ** 2 / total_mass))
        x_acc = temp - pole_mass_length * theta_acc * cos / total_mass
        self.state = np.array([x + self.tau * x_dot, x_dot + self.tau * x_acc, theta + self.tau * theta_dot, theta_dot + self.tau * theta_acc])
        self.steps += 1
        done = bool(abs(self.state[0]) > self.x_limit or abs(self.state[2]) > self.theta_limit)
        truncated = bool(not done and self.steps >= MAX_STEPS)
        return self.state.astype(np.float32), 1.0, done, truncated


def evaluate(policy_fn, episodes=20, seed=0):
    """Return trung bình (tổng reward một episode, tối đa 200) của `policy_fn` trên `episodes` episode mới, episode thứ i bắt đầu từ seed + i (cố định, tái lập được).
    policy_fn(obs) nhận obs float32 shape (4,) và trả về một hành động 0 hoặc 1 (số nguyên Python). Không train, không ghi gì."""
    env = CartPole()
    total = 0.0
    for i in range(episodes):
        obs = env.reset(seed=seed + i)
        done = truncated = False
        while not (done or truncated):
            obs, reward, done, truncated = env.step(policy_fn(obs))
            total += reward
    return total / episodes


def plot_returns(returns, window=10, title=""):
    """Vẽ return của từng episode (mờ) và trung bình trượt `window` episode (đậm) theo thứ tự episode: đường học của agent."""
    import matplotlib.pyplot as plt
    r = np.asarray(returns, dtype=float)
    plt.plot(r, alpha=0.3, label="mỗi episode")
    if len(r) >= window:
        plt.plot(np.arange(window - 1, len(r)), np.convolve(r, np.ones(window) / window, mode="valid"), label=f"trung bình trượt {window}")
    plt.xlabel("episode")
    plt.ylabel("return")
    plt.title(title)
    plt.legend()
    plt.show()


class ActorCritic(nn.Module):
    """Mạng actor-critic cho CartPole, theo §6.1 của paper (thí nghiệm MuJoCo): hai mạng MLP RIÊNG nhau, mỗi mạng hai tầng ẩn 64 nơ-ron, kích hoạt tanh,
    không chia sẻ tham số giữa actor và critic.
    forward(obs) với obs float32 shape (B, 4) trả về (logits, value): logits shape (B, 2) là điểm số chưa chuẩn hóa của hai hành động (softmax cho xác suất),
    value shape (B,) là V(s) ước lượng cho từng trạng thái."""

    def __init__(self, obs_dim=OBS_DIM, n_actions=N_ACTIONS, hidden=64):
        super().__init__()
        self.actor = nn.Sequential(nn.Linear(obs_dim, hidden), nn.Tanh(), nn.Linear(hidden, hidden), nn.Tanh(), nn.Linear(hidden, n_actions))
        self.critic = nn.Sequential(nn.Linear(obs_dim, hidden), nn.Tanh(), nn.Linear(hidden, hidden), nn.Tanh(), nn.Linear(hidden, 1))

    def forward(self, obs):
        return self.actor(obs), self.critic(obs).squeeze(-1)
