def merge(lora):
    """lora: LoRALinear (bài lora-linear của bạn) -> một nn.Linear thường cho cùng đầu ra, dùng để suy luận.
    Không sửa lora hay lora.base. Tham số của kết quả đóng băng (requires_grad = False), không dính đồ thị autograd."""
    raise NotImplementedError
