def add_lora(model, r, alpha, targets):
    """Gắn LoRA vào model (một GPT của bạn): với mỗi khối trong model.blocks, thay mỗi lớp nn.Linear có đường dẫn trong
    `targets` (ví dụ "attn.qkv") bằng LoRALinear(lớp đó, r, alpha); đóng băng mọi tham số còn lại. Sửa tại chỗ, trả về chính model."""
    raise NotImplementedError


def count_params(model):
    """(số tham số đang học được, tổng số tham số) của model: hai số nguyên."""
    raise NotImplementedError
