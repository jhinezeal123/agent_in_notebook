class ReplayBuffer:
    def __init__(self, capacity):
        self.capacity = int(capacity)
        self.pos = 0
        self.data = []

    def push(self, s, a, r, s_next, done):
        item = (s, a, r, s_next, done)
        if len(self.data) < self.capacity:
            self.data.append(item)
        else:
            self.data[self.pos] = item
        self.pos = (self.pos + 1) % self.capacity

    def sample(self, batch_size, rng):
        if batch_size < 1 or batch_size > len(self.data):
            raise ValueError("batch_size không hợp lệ")
        idx = rng.choice(len(self.data), size=batch_size, replace=False)
        rows = [self.data[i] for i in idx]
        states = np.array([row[0] for row in rows], dtype=np.float32)
        actions = np.array([row[1] for row in rows], dtype=np.int64)
        rewards = np.array([row[2] for row in rows], dtype=np.float32)
        next_states = np.array([row[3] for row in rows], dtype=np.float32)
        dones = np.array([row[4] for row in rows], dtype=np.float32)
        return states, actions, rewards, next_states, dones

    def __len__(self):
        return len(self.data)
