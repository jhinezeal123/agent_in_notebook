**Biến thể của `eps-greedy-bandit`.** Ở bài gốc, bạn khám phá bằng cách tung đồng xu: đôi khi chọn tay ngẫu nhiên mù quáng. **UCB1** khám phá có chủ đích hơn: mỗi tay được cộng một **phần thưởng khám phá** (bonus) lớn khi tay đó ít được thử, rồi chọn tay có điểm cao nhất, không cần số ngẫu nhiên nào. Đổi đúng một chi tiết (luật chọn tay), giữ nguyên phần còn lại của bandit. Trước khi code, hãy trả lời câu dự đoán đi kèm bài.

Viết `select_ucb(q, n, t, c)`:

$$\text{score}_a = Q_a + c\,\sqrt{\frac{\ln t}{N_a}},\qquad a^\ast = \arg\max_a\,\text{score}_a$$

- `q`: `np.ndarray` float shape `(K,)`, ước lượng giá trị từng tay. `n`: `np.ndarray` số nguyên shape `(K,)`, số lần đã kéo từng tay. `t`: số nguyên $\ge 1$, **chỉ số của lượt chọn hiện tại đếm từ 1** (lượt đầu tiên $t = 1$; lúc chọn, tổng số lần đã kéo là $t - 1$). `c`: số thực $\ge 0$, mức độ ưu tiên khám phá.
- **Tay chưa thử** ($N_a = 0$) phải được chọn **trước mọi tay đã thử**, bất kể $Q$ của các tay kia lớn đến đâu. Nhiều tay chưa thử: chọn tay có **chỉ số nhỏ nhất**. Công thức ở trên không xác định khi $N_a = 0$ (chia cho 0): hàm của bạn **không được thực hiện phép chia cho 0**, kể cả khi numpy chỉ im lặng cho ra `inf` hoặc `nan`. Máy chấm bật chế độ báo lỗi cho chia cho 0 và giá trị không hợp lệ.
- Các tay đều đã thử: chọn tay có `score` lớn nhất; đồng điểm thì lấy chỉ số nhỏ nhất.
- Trả về chỉ số tay (một số nguyên). Không sửa `q` và `n`. Không dùng số ngẫu nhiên.

Bài `eps-greedy-bandit` của bạn đã định nghĩa `update(q, n, a, r)`: máy chấm dùng lại nó để chạy một vòng bandit đầy đủ với luật chọn mới của bạn, nên bạn không phải viết lại.

Chỉ cần NumPy.
