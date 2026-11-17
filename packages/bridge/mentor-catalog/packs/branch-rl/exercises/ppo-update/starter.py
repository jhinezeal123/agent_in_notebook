def ppo_update(policy, optimizer, batch, clip_eps, vf_coef, ent_coef, epochs, minibatch_size, generator, max_grad_norm=0.5):
    """Cập nhật PPO trên một rollout. policy(obs) -> (logits (B, A), value (B,)); batch: dict với "obs" (N, d), "actions" (N,) int64,
    "old_logp" (N,), "advantages" (N,), "returns" (N,). Mỗi epoch: xáo trộn bằng minibatch_indices (cho sẵn), mỗi minibatch:
    loss = ppo_clip_loss(...) + vf_coef * mse(value, returns) - ent_coef * entropy; zero_grad, backward, cắt chuẩn gradient (nếu max_grad_norm
    không phải None), step. Trả về dict số Python: trung bình trên mọi lần cập nhật của "loss", "clip_fraction", "approx_kl" (tính trước step)."""
    raise NotImplementedError
