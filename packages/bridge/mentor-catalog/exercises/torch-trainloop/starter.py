def train_epoch(model, batches, opt, loss_fn):
    """batches: các cặp (x (n_b, ...), y (n_b,) int64). Một bước tối ưu mỗi batch -> float: loss trung bình theo mẫu."""
    ...


def evaluate(model, batches, loss_fn):
    """Không cập nhật gì -> (loss trung bình theo mẫu: float, accuracy: float trong [0, 1])."""
    ...
