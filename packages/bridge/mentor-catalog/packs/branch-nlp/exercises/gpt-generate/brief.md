Viết hàm `generate(model, idx, max_new_tokens, temperature=1.0, top_k=None)`: cho một mô hình ngôn ngữ kiểu GPT và một đoạn mở đầu (prompt), sinh thêm `max_new_tokens` token, mỗi lần một token, mỗi token **lấy mẫu** từ phân phối mô hình dự đoán. Bài `gpt-mini` của bạn đã định nghĩa `GPT`: dùng lại nó để thử (máy chấm cũng thử trên nó).

**Mô hình** `model` có thuộc tính `block_size`, và `model(x)` với `x` shape `(B, T)`, `T ≤ block_size`, trả về cặp `(logits, loss)`, `logits` shape `(B, T, V)`.

**Phân phối của token kế.** Gọi $z \in \mathbb{R}^{V}$ là logits ở **vị trí cuối** của chuỗi mà mô hình vừa nhìn, $\tau$ là `temperature` (số dương) và $k$ là `top_k`. Token kế được lấy mẫu từ

$$p = \operatorname{softmax}\!\left(\frac{\tilde z}{\tau}\right), \qquad \tilde z_i = \begin{cases} z_i & z_i \text{ nằm trong } k \text{ giá trị lớn nhất của } z \\ -\infty & \text{ngược lại} \end{cases}$$

Không có `top_k` (`None`) thì $\tilde z = z$. Nếu `top_k` lớn hơn hoặc bằng cỡ từ vựng $V$ thì không loại token nào.

**Tham số và kết quả**

- `idx`: tensor số nguyên `(B, T0)`, prompt. Trả về tensor số nguyên `(B, T0 + max_new_tokens)`: `T0` cột đầu đúng là prompt, các cột sau là token mới. `idx` của người gọi **không bị sửa** tại chỗ.
- Mô hình chỉ có `block_size` vị trí, nên khi chuỗi hiện có dài hơn `block_size`, mỗi bước chỉ đưa cho mô hình `block_size` token cuối.
- Lấy mẫu bằng **`torch.multinomial(probs, num_samples=1)`**, đúng một lần mỗi bước và không dùng nguồn ngẫu nhiên nào khác: máy chấm đặt cùng seed rồi so chuỗi của bạn với chuỗi của lời giải chuẩn, token từng token.
- Sinh văn bản là suy luận chứ không phải huấn luyện: mô hình phải ở chế độ **eval** và không ghi đồ thị gradient trong lúc sinh. Sau khi `generate` trả về, chế độ train/eval của `model` phải đúng như trước khi gọi.
- Bạn không cần xử lý `temperature = 0` (bài `gpt-temperature` làm việc đó).
