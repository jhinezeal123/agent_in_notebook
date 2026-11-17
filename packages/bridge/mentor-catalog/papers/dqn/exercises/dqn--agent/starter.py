class QNet(nn.Module):
    """MLP: obs (B, obs_dim) -> Q-value của mọi hành động (B, n_actions).
    Ba lớp nn.Linear tên self.fc1 (obs_dim -> hidden), self.fc2 (hidden -> hidden), self.out (hidden -> n_actions).
    ReLU sau fc1 và fc2; không có kích hoạt ở đầu ra."""

    def __init__(self, obs_dim=4, n_actions=2, hidden=64):
        super().__init__()
        raise NotImplementedError

    def forward(self, x):
        raise NotImplementedError


def epsilon_by_step(step, eps_start, eps_end, decay_steps):
    """ε của ε-greedy ở bước `step`: giảm tuyến tính từ eps_start (bước 0) xuống eps_end (bước decay_steps), rồi giữ ở eps_end. Trả về float."""
    raise NotImplementedError


def select_action(q_net, obs, eps, rng):
    """Một hành động cho MỘT trạng thái. obs: np.ndarray (obs_dim,); rng: np.random.Generator.
    Xác suất eps: hành động ngẫu nhiên đều; ngược lại: hành động có Q lớn nhất. Trả về int Python; không tạo đồ thị gradient."""
    raise NotImplementedError


def sync_target(q_net, target_net, tau=1.0):
    """Sửa target_net tại chỗ: target <- tau * q + (1 - tau) * target, cho từng tham số. tau = 1: sao chép cứng. Không đổi q_net, không trả về gì."""
    raise NotImplementedError


def dqn_train_step(q_net, target_net, optimizer, buffer, batch_size, gamma, rng):
    """Một bước học: bốc batch từ buffer (ReplayBuffer của bạn) bằng rng, tính dqn_loss, một bước optimizer cho q_net.
    Buffer có ít hơn batch_size transition: trả về None (chưa học). Ngược lại trả về loss dạng float Python."""
    raise NotImplementedError
