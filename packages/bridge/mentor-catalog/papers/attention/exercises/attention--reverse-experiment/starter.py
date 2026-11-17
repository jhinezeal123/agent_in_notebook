# Cell train. Chạy xong cell này, biến toàn cục `model` phải giữ Transformer đã train.
torch.manual_seed(0)

# 0. Thiết bị: GPU nếu có (torch.cuda.is_available()), không thì CPU. Mô hình và mỗi batch phải cùng thiết bị.

# 1. Mô hình: Transformer của bạn, cỡ nhỏ (xem bảng cấu hình trong đề).
model = ...

# 2. Optimizer Adam và lịch learning rate của paper (Eq. 3, §5.3).
...

# 3. Vòng train: mỗi bước lấy một batch mới từ make_batch, forward, loss, backward, cập nhật.
...
