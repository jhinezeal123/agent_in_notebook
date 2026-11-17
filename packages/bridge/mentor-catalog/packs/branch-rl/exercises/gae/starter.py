def compute_gae(rewards, values, dones, last_value, gamma, lam):
    """GAE(gamma, lambda) cho một rollout. rewards, values, dones: (T,) float32 (dones[t] = 1.0: episode kết thúc ngay sau bước t);
    last_value: V của trạng thái sau bước cuối (số thực hoặc tensor 0 chiều). values có thể đang có gradient: kết quả không được dính đồ thị.
    delta_t = r_t + gamma * (1 - d_t) * V_(t+1) - V_t;  A_t = delta_t + gamma * lam * (1 - d_t) * A_(t+1);  returns = A + V.
    Trả về (advantages, returns), mỗi cái (T,) float32 không gradient; không sửa đầu vào."""
    raise NotImplementedError
