def ppo_clip_loss(new_logp, old_logp, advantages, clip_eps):
    """Loss PPO có cắt: -mean( min(r * A, clip(r, 1 - eps, 1 + eps) * A) ), r = tỉ số xác suất tính từ hai log-xác suất.
    new_logp: (B,) float32 có gradient; old_logp: (B,) float32 (hằng số); advantages: (B,) float32 thô (không chuẩn hóa ở đây, hằng số).
    clip_eps: số thực > 0. Trả về tensor vô hướng; gradient chỉ chảy vào new_logp."""
    raise NotImplementedError
