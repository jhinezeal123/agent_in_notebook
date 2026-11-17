def select_action(q, eps, rng):
    """Epsilon-greedy: xác suất eps chọn đều ngẫu nhiên trong K tay, ngược lại chọn tay có q lớn nhất
    (đồng hạng thì chọn ngẫu nhiên đều bằng rng). q: (K,) float, rng: numpy Generator. Trả về chỉ số tay."""
    raise NotImplementedError


def update(q, n, a, r):
    """Sửa TẠI CHỖ q và n sau khi kéo tay a nhận thưởng r: n[a] tăng 1, q[a] thành trung bình cộng
    mọi thưởng của tay a (dạng tăng dần, không lưu lịch sử). Không trả về gì."""
    raise NotImplementedError


def run_bandit(rewards, eps, rng):
    """rewards: (steps, K), tay a ở lượt t cho rewards[t, a]. Bắt đầu q = 0, n = 0; mỗi lượt dùng
    select_action rồi update. Trả về (q, n, actions) với actions int64 (steps,)."""
    raise NotImplementedError
