Tự viết lại `nn.Linear` và ghép thành một MLP hai lớp, theo đúng cách PyTorch tổ chức mô hình: kế thừa `nn.Module`, khai báo tham số trong `__init__`, tính toán trong `forward`. Không dùng `nn.Linear` hay `F.linear`.

**1. `class MyLinear(nn.Module)`**, khởi tạo `MyLinear(in_features, out_features)`:

- Thuộc tính `self.weight` shape `(out_features, in_features)` và `self.bias` shape `(out_features,)`, phải là **tham số của module** (xuất hiện trong `module.parameters()` và `module.state_dict()`, optimizer thấy được).
- Khởi tạo như `nn.Linear`: cả weight và bias lấy ngẫu nhiên đều trong $\left[-\frac{1}{\sqrt{\text{in}}},\ \frac{1}{\sqrt{\text{in}}}\right]$.
- `forward(x)`: `x` shape `(..., in_features)` → `(..., out_features)`, với

$$y = x W^\top + b$$

  Phải chạy với cả `x` 2 chiều `(N, in)` lẫn 3 chiều `(B, T, in)`.

**2. `class MLP(nn.Module)`**, khởi tạo `MLP(d_in, d_hidden, d_out)`:

- Đúng hai thuộc tính con: `self.fc1` là một `MyLinear` từ `d_in` sang `d_hidden`, `self.fc2` là một `MyLinear` từ `d_hidden` sang `d_out`. Tên tham số trong `state_dict()` vì vậy là `fc1.weight`, `fc1.bias`, `fc2.weight`, `fc2.bias` (máy chấm chép trọng số theo đúng các tên này).
- `forward(x)`: `x` shape `(..., d_in)` → `(..., d_out)`:

$$\text{MLP}(x) = \text{fc2}\big(\operatorname{ReLU}(\text{fc1}(x))\big)$$

Nhớ gọi `super().__init__()` trước khi gán bất cứ thứ gì vào `self`.
