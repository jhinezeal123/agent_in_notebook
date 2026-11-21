Khi tự viết backprop bằng tay, công cụ kiểm chứng đáng tin nhất là **sai phân trung tâm (central finite difference)**. Viết hai hàm:

1. `numerical_grad(f, x, eps=1e-5)`: với hàm vô hướng `f(arr) -> float` và mảng thực `x` có **shape bất kỳ** (1D, 2D, 3D…), tính xấp xỉ gradient tại từng tọa độ $i$:
   $$(\nabla f(x))_i \approx \frac{f(x + \varepsilon e_i) - f(x - \varepsilon e_i)}{2\varepsilon}.$$
   Trả về mảng float cùng shape với `x`, **không làm thay đổi `x` tại chỗ**.

2. `grad_rel_error(g_analytic, g_numeric, eps=1e-8)`: trả về sai số tương đối L2 (`float`):
   $$\frac{\|g_a - g_n\|_2}{\max(\|g_a\|_2 + \|g_n\|_2, \varepsilon)}.$$
