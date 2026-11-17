Viết hàm `euler_sample(model, x0, steps)`: sinh mẫu từ một mô hình **flow matching** đã train, bằng cách giải phương trình vi phân thường (ODE) $\dfrac{dx}{dt}=v_\theta(x,t)$ từ $t=0$ (nhiễu) tới $t=1$ (dữ liệu) bằng **phương pháp Euler**. Lưu ý: bài này ở sao Flow matching, **chưa phải paper mốc**. Quy ước **giống bài `flow-matching-loss`**: $t=0$ là nhiễu, $t=1$ là dữ liệu, mô hình nhận `t` shape `(B,)` và trả về vận tốc.

**Thuật toán.** Chia $[0,1]$ thành `steps` bước **đều nhau**: $\Delta t=1/\text{steps}$, và bước thứ $k$ ($k=0,1,\dots,\text{steps}-1$) bắt đầu ở thời gian $t_k=k/\text{steps}$. Euler cập nhật

$$x_{k+1}=x_k+\Delta t\; v_\theta\big(x_k,\,t_k\big),\qquad x_0\ \text{cho trước (nhiễu)}$$

và trả về $x_\text{steps}$ (xấp xỉ điểm dữ liệu tại $t=1$). Mỗi bước dùng vận tốc đo ở **đầu bước** (không phải cuối bước hay giữa bước).

**Tham số**

- `model`: gọi như `model(x, t)`, với `x` shape `(B, ...)` và `t` tensor số thực **shape `(B,)`**, cùng kiểu số và thiết bị với `x`, mọi phần tử bằng $t_k$ (cả batch ở cùng một thời gian). Trả về vận tốc **cùng shape** với `x`. Test dùng các trường vận tốc giải tích đơn giản (không phải mạng).
- `x0`: tensor shape `(B, ...)` (vectơ hoặc ảnh), điểm xuất phát. **Không được sửa tại chỗ.**
- `steps`: số nguyên $\ge 1$. Model được gọi **đúng `steps` lần**.

**Trả về:** tensor cùng shape và **cùng kiểu số** với `x0` (một tensor mới, không phải chính `x0`).

Ràng buộc: sinh mẫu là suy luận, không huấn luyện, nên **không ghi đồ thị gradient** (kể cả bên trong lúc gọi `model`); cả hàm trả về tensor không có `requires_grad`. Không dùng phương pháp bậc cao hơn (Heun, RK4): đề đòi đúng Euler.

Trước khi code, hãy tự dự đoán (rồi kiểm ở lab): với bài toán $\dfrac{dx}{dt}=-x$, $x(0)=1$ thì $x(1)=e^{-1}\approx0.368$. Euler một bước cho bao nhiêu? Hai bước? Khi tăng gấp đôi số bước thì sai số so với $e^{-1}$ giảm khoảng mấy lần?
