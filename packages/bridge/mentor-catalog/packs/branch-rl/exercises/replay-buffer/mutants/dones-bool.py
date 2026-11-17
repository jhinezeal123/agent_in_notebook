class ReplayBuffer:
    def __init__(self, capacity):
        self.capacity = int(capacity)
        self.pos = 0
        self.size = 0
        self.states = None

    def push(self, s, a, r, s_next, done):
        if self.states is None:
            d = np.asarray(s).shape[0]
            self.states = np.zeros((self.capacity, d), dtype=np.float32)
            self.next_states = np.zeros((self.capacity, d), dtype=np.float32)
            self.actions = np.zeros(self.capacity, dtype=np.int64)
            self.rewards = np.zeros(self.capacity, dtype=np.float32)
            self.dones = np.zeros(self.capacity, dtype=bool)
        i = self.pos
        self.states[i] = s
        self.actions[i] = a
        self.rewards[i] = r
        self.next_states[i] = s_next
        self.dones[i] = float(done)
        self.pos = (self.pos + 1) % self.capacity
        self.size = min(self.size + 1, self.capacity)

    def sample(self, batch_size, rng):
        if batch_size < 1 or batch_size > self.size:
            raise ValueError(f"batch_size = {batch_size} không hợp lệ khi bộ đệm có {self.size} phần tử")
        idx = rng.choice(self.size, size=batch_size, replace=False)
        return self.states[idx], self.actions[idx], self.rewards[idx], self.next_states[idx], self.dones[idx]

    def __len__(self):
        return self.size
