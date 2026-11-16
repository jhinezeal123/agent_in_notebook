Cell bài làm đã có sẵn một vòng lặp train MLP (mini-batch SGD, softmax cross-entropy) cho dữ liệu đồ chơi hình XOR. Nó **chạy được nhưng không học** vì có lỗi được cài sẵn — có thể nhiều hơn một.

Việc của bạn:

1. Chạy, nhìn đường loss và độ chính xác, **đặt giả thuyết trước khi sửa** (ghi vào cell Phác thảo: triệu chứng → nghi ngờ → cách kiểm).
2. Sửa để `train(X, y, ...)` trả về `(params, losses)` và `predict(params, X)` trả về nhãn dự đoán; với tham số mặc định, độ chính xác trên tập train và tập kiểm tra đều ≥ 95%.

Không đổi tên hàm hay tham số mặc định. Hàm `make_xor` trong Phòng công thức tạo dữ liệu.
