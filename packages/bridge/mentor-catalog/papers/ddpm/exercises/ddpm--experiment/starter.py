# Cell train. Chạy xong cell này, hai biến toàn cục `sched` và `model` phải giữ lịch nhiễu và U-Net đã train.
torch.manual_seed(0)
device = "cuda" if torch.cuda.is_available() else "cpu"

# 1. Lịch nhiễu T = 200 (make_schedule của bạn, β co giãn theo đề), mọi tensor nằm trên `device`.
sched = ...

# 2. Dữ liệu: load_mnist(20000), đưa lên `device`.
...

# 3. Mô hình TinyUNet (cho sẵn) trên `device` và optimizer Adam.
model = ...

# 4. Vòng train: mỗi bước lấy một batch ngẫu nhiên, loss bằng ddpm_loss của bạn, backward, cập nhật. In loss mỗi 500 bước.
...

# 5. Xem thử: sinh 16 ảnh bằng sample của bạn rồi vẽ bằng show_images.
