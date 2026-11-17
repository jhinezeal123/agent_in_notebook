import math

# Hai tác vụ đồ chơi trên một bảng chữ cái 16 ký tự a..p (token 0..15).
# Mỗi chuỗi dài SEQ_LEN: ký tự đầu ngẫu nhiên, mỗi ký tự sau là "kế tiếp" của ký tự trước theo quy tắc của tác vụ
# (xác suất 1 - NOISE), còn lại (xác suất NOISE) là một ký tự ngẫu nhiên.
#   Tác vụ "A" (huấn luyện trước): bảng chữ cái xoay vòng, a -> b -> c -> ... -> p -> a.
#   Tác vụ "B" (cần fine-tune sang): như A nhưng đổi chỗ bốn quy tắc: c -> k (thay vì d), j -> d, f -> n (thay vì g), m -> g.
CHARS = "abcdefghijklmnop"
VOCAB_SIZE = len(CHARS)
SEQ_LEN = 24
NOISE = 0.1

_SUCC_A = [(c + 1) % VOCAB_SIZE for c in range(VOCAB_SIZE)]
_SUCC_B = list(_SUCC_A)
for _x, _y in [(2, 9), (5, 12)]:
    _SUCC_B[_x], _SUCC_B[_y] = _SUCC_A[_y], _SUCC_A[_x]
SUCC = {"A": _SUCC_A, "B": _SUCC_B}

# Cỡ mô hình dùng cho cả hai tác vụ: GPT(vocab_size, block_size, n_embd, n_head, n_layer) của bài gpt-mini của bạn.
GPT_CONFIG = (VOCAB_SIZE, SEQ_LEN, 64, 4, 2)

# Ngay cả mô hình biết đúng quy tắc cũng không thắng được phần nhiễu: đây là loss nhỏ nhất có thể (nat/token).
_P_RIGHT = 1 - NOISE + NOISE / VOCAB_SIZE
_P_OTHER = NOISE / VOCAB_SIZE
LOSS_FLOOR = -(_P_RIGHT * math.log(_P_RIGHT) + (VOCAB_SIZE - 1) * _P_OTHER * math.log(_P_OTHER))


def make_batch(task, n, generator):
    """n chuỗi của tác vụ "A" hoặc "B": tensor int64 shape (n, SEQ_LEN), token trong [0, VOCAB_SIZE).
    `generator` là một torch.Generator (để tái lập được)."""
    succ = torch.tensor(SUCC[task], dtype=torch.long)
    x = torch.empty(n, SEQ_LEN, dtype=torch.long)
    x[:, 0] = torch.randint(0, VOCAB_SIZE, (n,), generator=generator)
    for t in range(1, SEQ_LEN):
        follow = succ[x[:, t - 1]]
        noisy = torch.rand(n, generator=generator) < NOISE
        other = torch.randint(0, VOCAB_SIZE, (n,), generator=generator)
        x[:, t] = torch.where(noisy, other, follow)
    return x


def to_text(seq):
    """Một chuỗi token (1 chiều) thành chữ để đọc, ví dụ 'cdefghij...'."""
    return "".join(CHARS[int(i)] for i in seq)


@torch.no_grad()
def eval_loss(model, task, n=2048, seed=2024):
    """Loss cross-entropy trung bình (nat/token) của model trên n chuỗi mới của `task`, dự đoán token kế tiếp ở mọi vị trí.
    Thấp nhất có thể: LOSS_FLOOR."""
    was_training = model.training
    model.eval()
    x = make_batch(task, n, torch.Generator().manual_seed(seed)).to(next(model.parameters()).device)
    logits, _ = model(x)
    loss = F.cross_entropy(logits[:, :-1].reshape(-1, VOCAB_SIZE), x[:, 1:].reshape(-1))
    model.train(was_training)
    return float(loss)


def pretrain(steps=1000, seed=0):
    """Huấn luyện trước một GPT (bài gpt-mini của bạn) trên tác vụ "A": cỡ GPT_CONFIG, Adam lr 3e-3, batch 64.
    Trả về mô hình đã train (khoảng 1 phút trên CPU). Lưu thêm một bản sao trọng số vào biến toàn cục PRETRAINED_STATE
    để máy chấm so sánh sau này; mỗi lần gọi là một mô hình huấn luyện trước mới."""
    torch.manual_seed(seed)
    model = GPT(*GPT_CONFIG)
    opt = torch.optim.Adam(model.parameters(), lr=3e-3)
    gen = torch.Generator().manual_seed(seed + 1)
    model.train()
    for _ in range(steps):
        x = make_batch("A", 64, gen)
        _, loss = model(x, x)
        opt.zero_grad()
        loss.backward()
        opt.step()
    globals()["PRETRAINED_STATE"] = {k: v.detach().clone() for k, v in model.state_dict().items()}
    return model
