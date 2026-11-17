Viết `compute_gae(rewards, values, dones, last_value, gamma, lam)`: **Generalized Advantage Estimation**. Sau khi chạy policy `T` bước trong môi trường (một **rollout**), hàm này cho mỗi bước biết hành động đó **tốt hơn mức trung bình bao nhiêu** (advantage), và đồng thời cho mục tiêu để huấn luyện mạng giá trị (`returns`). Đây là bước tính tín hiệu học ở trái tim của PPO.

**Công thức.** Gọi $V_t$ là giá trị mạng ước lượng cho trạng thái $s_t$, $d_t \in \{0, 1\}$ là cờ `done` của bước $t$:

$$\delta_t = r_t + \gamma\,(1 - d_t)\,V_{t+1} - V_t,\qquad
A_t = \delta_t + \gamma\lambda\,(1 - d_t)\,A_{t+1},\qquad
\text{returns}_t = A_t + V_t$$

- $\delta_t$ là **sai số TD**: thưởng thật cộng ước lượng cho tương lai, trừ ước lượng hiện tại. $A_t$ cộng dồn các $\delta$ về sau với trọng số $(\gamma\lambda)^k$, tính **ngược** từ bước cuối.
- $d_t = 1$ nghĩa là episode **kết thúc ngay sau bước $t$**: không còn tương lai, nên cả $V_{t+1}$ lẫn $A_{t+1}$ (thuộc episode khác hoặc không tồn tại) đều bị chặn.
- Ở cuối rollout ($t = T-1$), $V_T$ không có trong `values`: dùng **`last_value`** (giá trị mạng ước lượng cho trạng thái sau bước cuối) để bootstrap, và $A_T = 0$.
- $\lambda = 0$ cho $A_t = \delta_t$ (chỉ nhìn một bước, nhiều bias, ít phương sai); $\lambda = 1$ cho tổng chênh lệch tới hết episode (Monte-Carlo, ít bias, nhiều phương sai).

**Vào/ra** (một môi trường, `T` bước liên tiếp, các episode có thể nối nhau)

- `rewards`: `float32`, `(T,)`.
- `values`: `float32`, `(T,)`, $V_t = V(s_t)$. **Có thể đang gắn gradient** (đầu ra của critic); kết quả không được dính đồ thị đó.
- `dones`: `float32`, `(T,)`, 0.0 hoặc 1.0.
- `last_value`: một số thực Python hoặc tensor 0 chiều.
- `gamma`, `lam`: số thực trong `[0, 1]`.
- Trả về bộ `(advantages, returns)`, mỗi tensor `float32` shape `(T,)`, **không** có gradient.

**Lưu ý**

- Không sửa các tensor vào. Vòng lặp ngược bằng Python là đủ, không cần autograd.
- Hàm **không** chuẩn hóa advantage (việc đó làm ở nơi dùng nó, sau khi đã có `returns`).
- Bài `returns-to-go` bạn đã làm là trường hợp riêng nhìn xa nhất: so sánh với $\lambda = 1$ nếu muốn.

Máy chấm kiểm: một ví dụ tính tay, chặn ở biên episode (cả $V_{t+1}$ lẫn $A_{t+1}$), `last_value` bootstrap đúng ở cuối rollout, hai cực $\lambda = 0$ và $\lambda = 1$ so với tính tay bằng NumPy, `returns` $= A + V$, khớp lời giải chuẩn trên nhiều rollout, và dtype/shape/không gradient/không sửa đầu vào.
