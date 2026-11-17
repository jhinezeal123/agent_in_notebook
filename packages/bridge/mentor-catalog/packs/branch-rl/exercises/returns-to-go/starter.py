def returns_to_go(rewards, gamma, dones=None):
    """Return còn lại G_t = r_t + gamma * G_(t+1) cho mỗi bước.
    rewards: (T,) số (có thể là int); gamma: số thực; dones: None hoặc (T,) bool/0-1, dones[t] khác 0 nghĩa là bước t là bước cuối của một episode
    (G_t = r_t, không cộng thưởng của episode sau). Bước cuối mảng không bootstrap. Trả về np.ndarray float (T,); không sửa đầu vào."""
    raise NotImplementedError
