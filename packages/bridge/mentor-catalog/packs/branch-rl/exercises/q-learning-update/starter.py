def q_update(Q, s, a, r, s_next, done, alpha, gamma):
    """Một bước Q-learning. Sửa TẠI CHỖ Q[s, a]; không đổi phần tử nào khác.
    Q: (S, A) float; s, a, s_next: số nguyên; r: float; done: bool; alpha, gamma: float.
    Trả về TD error = target - Q[s, a] (tính trước khi sửa), kiểu float. Khi done thì target không có phần tương lai."""
    raise NotImplementedError


def q_learning(env, episodes, alpha, gamma, eps, rng):
    """Q-learning bảng. Q khởi tạo toàn 0, shape (env.n_states, env.n_actions). Mỗi episode: env.reset(), rồi
    lặp: chọn hành động epsilon-greedy theo Q[s] (đồng hạng thì chọn ngẫu nhiên bằng rng), env.step, q_update,
    tới khi done. Trả về Q."""
    raise NotImplementedError
