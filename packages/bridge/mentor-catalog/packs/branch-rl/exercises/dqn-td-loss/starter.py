def dqn_loss(q_net, target_net, batch, gamma):
    """Loss TD của DQN trên một batch. batch = (states (B, d) float32, actions (B,) int64, rewards (B,), next_states (B, d), dones (B,) float32 0/1).
    q_net, target_net: nn.Module nhận (B, d), trả Q (B, A). Loss = trung bình theo batch của Huber (F.smooth_l1_loss) giữa
    Q(s, a) của q_net (hành động đã chọn) và target r + gamma * (1 - done) * max_a' Q_target(s', a'), target không nhận gradient.
    Trả về tensor vô hướng."""
    raise NotImplementedError
