**Biến thể của `gae`.** Ở bài gốc bạn đệ quy trên **advantage**: $A_t = \delta_t + \gamma\lambda(1-d_t)A_{t+1}$, rồi mới cộng $V$ để ra `returns`. Biến thể này đổi **đúng một chi tiết**: đệ quy thẳng trên **$\lambda$-return** $G^\lambda_t$, tức chính con số `returns` (mục tiêu cho mạng giá trị), mà không cần đi qua advantage. Nhìn ở dạng này, ý nghĩa của $\lambda$ lộ rõ: **mỗi bước pha trộn** "tin vào $V$ của bước sau" với "tin vào return thật của bước sau". Trước khi code, hãy trả lời câu dự đoán đi kèm bài.

Viết `lambda_return(rewards, values, dones, last_value, gamma, lam)`:

$$G^\lambda_t = r_t + \gamma\,(1 - d_t)\,\Big[(1-\lambda)\,V_{t+1} + \lambda\,G^\lambda_{t+1}\Big],\qquad V_T = G^\lambda_T = \text{last\_value}$$

- Vào: giống hệt `compute_gae`. `rewards`, `values`, `dones`: `float32`, `(T,)` (`dones[t] = 1.0`: episode kết thúc ngay sau bước $t$); `last_value`: số thực hoặc tensor 0 chiều; `gamma`, `lam` trong `[0, 1]`. `values` có thể đang gắn gradient: kết quả không được dính đồ thị.
- Ra: một tensor `float32`, shape `(T,)`, không có gradient: $G^\lambda_t$ cho mỗi bước.
- **Hai cực**: $\lambda = 0$ cho $G_t = r_t + \gamma(1-d_t)V_{t+1}$ (mục tiêu TD một bước), $\lambda = 1$ cho return Monte-Carlo, bootstrap bằng `last_value` ở cuối rollout.
- Kết quả phải **bằng đúng** `returns` mà `compute_gae` của bạn trả về với cùng đầu vào: bài `gae` của bạn đã định nghĩa `compute_gae(rewards, values, dones, last_value, gamma, lam)`, máy chấm dùng lại nó để so, bạn không phải viết lại.
- Không sửa các tensor vào. Vòng lặp ngược bằng Python là đủ.

Máy chấm kiểm: ví dụ tính tay ở ba giá trị của $\lambda$, các cực $\lambda = 0$ và $\lambda = 1$ so với tính tay bằng NumPy, chặn ở biên episode, `last_value`, khớp `returns` của `compute_gae` của bạn, khớp lời giải chuẩn, và dtype/shape/không gradient/không sửa đầu vào.
