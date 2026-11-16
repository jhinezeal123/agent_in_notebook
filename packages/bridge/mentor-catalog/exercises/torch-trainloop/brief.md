Viết hai hàm mà gần như dự án PyTorch nào cũng có: train một epoch và đánh giá. Mô hình là một bài phân loại: `model(x)` trả về logits shape `(n, C)`, nhãn `y` shape `(n,)` kiểu `int64`.

`batches` là một iterable các cặp `(x, y)` (một list, hoặc một `DataLoader`): `x` shape `(n_b, ...)`, `y` shape `(n_b,)`. Các batch **có thể khác cỡ** (batch cuối thường nhỏ hơn). `loss_fn(logits, y)` trả về loss **trung bình trên batch** (như `nn.CrossEntropyLoss()`).

**1. `train_epoch(model, batches, opt, loss_fn) -> float`**: đi qua mọi batch một lần, mỗi batch một bước tối ưu bằng `opt`. Trả về loss trung bình **theo mẫu** của cả epoch:

$$\bar L = \frac{\sum_b n_b\, L_b}{\sum_b n_b}$$

với $L_b$ là loss của batch $b$, tính lúc forward (trước bước cập nhật của chính batch đó).

- Mô hình có thể có dropout, và có thể đang ở chế độ eval lúc được đưa vào: khi train, dropout phải **bật**.
- Mỗi bước chỉ dùng gradient của **đúng batch đó**.
- Trả về một số Python (`float`), không phải tensor.

**2. `evaluate(model, batches, loss_fn) -> (float, float)`**: không cập nhật gì, trả về `(loss trung bình theo mẫu, accuracy)`, accuracy là tỉ lệ mẫu có `argmax` của logits bằng nhãn (một số trong `[0, 1]`).

- Đánh giá phải **tất định**: gọi hai lần ra đúng một kết quả, dù mô hình có dropout.
- Không xây đồ thị autograd khi đánh giá (tốn bộ nhớ vô ích).
- Không để lại `.grad` trên tham số.
