class LoRALinear(nn.Module):
    """Bọc một nn.Linear đã có (base) và thêm độ lệch hạng thấp scale * B @ A, scale = alpha / r.
    Thuộc tính: base (đóng băng), A (r, in), B (out, r), scale (số thực).
    forward: x (..., in) -> (..., out)."""

    def __init__(self, base, r=4, alpha=8.0):
        raise NotImplementedError

    def forward(self, x):
        raise NotImplementedError
