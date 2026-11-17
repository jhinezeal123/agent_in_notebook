def euler_sample(model, x0, steps):
    """Tích phân dx/dt = v(x, t) từ t = 0 đến 1 bằng Euler, `steps` bước đều (dt = 1/steps), bước k bắt đầu ở t_k = k/steps.
    model(x, t) -> vận tốc cùng shape x, với t: tensor số thực (B,) toàn giá trị t_k (cùng kiểu số và thiết bị với x).
    x0: (B, ...) không bị sửa tại chỗ; không ghi gradient. Trả về tensor mới cùng shape và kiểu số với x0."""
    raise NotImplementedError
