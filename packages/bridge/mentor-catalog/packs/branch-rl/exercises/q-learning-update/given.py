class GridWorld:
    """Lưới n x n, trạng thái là số nguyên s = hàng * n + cột.
    Bắt đầu ở ô 0 (góc trên trái); đích là ô n*n - 1 (góc dưới phải).
    Hành động: 0 = lên, 1 = phải, 2 = xuống, 3 = trái. Đi ra ngoài lưới thì đứng yên.
    Mỗi bước thưởng -1; bước đến đích thì done = True (hết episode)."""

    n_actions = 4

    def __init__(self, n=4, max_steps=500):
        self.n = n
        self.n_states = n * n
        self.goal = n * n - 1
        self.max_steps = max_steps
        self.s = 0
        self.t = 0

    def reset(self):
        """Bắt đầu episode mới, trả về trạng thái đầu (ô 0)."""
        self.s = 0
        self.t = 0
        return self.s

    def step(self, a):
        """Thực hiện hành động a. Trả về (s_next, r, done)."""
        if self.t >= self.max_steps:
            raise RuntimeError(f"Episode dài quá {self.max_steps} bước: vòng lặp của bạn có dừng khi done = True không?")
        row, col = divmod(self.s, self.n)
        drow, dcol = [(-1, 0), (0, 1), (1, 0), (0, -1)][a]
        row = min(max(row + drow, 0), self.n - 1)
        col = min(max(col + dcol, 0), self.n - 1)
        self.s = row * self.n + col
        self.t += 1
        return self.s, -1.0, self.s == self.goal
