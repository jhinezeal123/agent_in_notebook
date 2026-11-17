class ReplayBuffer:
    """Bộ đệm vòng chứa tối đa `capacity` transition (s, a, r, s_next, done); đầy thì ghi đè cái cũ nhất."""

    def __init__(self, capacity):
        """capacity: số nguyên >= 1, số transition tối đa."""
        raise NotImplementedError

    def push(self, s, a, r, s_next, done):
        """Thêm một transition: s, s_next là vector 1 chiều (d,), a số nguyên, r số thực, done bool.
        Lưu BẢN SAO của s và s_next (người gọi có thể sửa mảng của họ sau đó)."""
        raise NotImplementedError

    def sample(self, batch_size, rng):
        """Bốc ngẫu nhiên đều batch_size transition KHÁC NHAU trong số đã ghi, dùng rng (numpy Generator).
        Trả về (states (B, d) float32, actions (B,) int64, rewards (B,) float32, next_states (B, d) float32, dones (B,) float32).
        batch_size < 1 hoặc lớn hơn len(self): raise ValueError."""
        raise NotImplementedError

    def __len__(self):
        """Số transition đang có: min(số lần push, capacity)."""
        raise NotImplementedError
