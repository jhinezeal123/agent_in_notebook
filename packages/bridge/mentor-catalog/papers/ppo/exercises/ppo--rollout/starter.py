def collect_rollout(env, obs, policy, steps, gamma, lam, generator):
    """Chạy policy `steps` bước trong env (đang ở trạng thái obs), rồi tính advantage bằng compute_gae của bạn.
    env: CartPole đang chạy; obs: np.ndarray float32 (4,) trạng thái hiện tại; policy(obs (B, 4)) -> (logits (B, 2), value (B,));
    generator: torch.Generator để lấy mẫu hành động bằng torch.multinomial.
    Trả về (batch, obs, episode_returns):
      batch: dict "obs" (T, 4) float32, "actions" (T,) int64, "old_logp" (T,), "advantages" (T,), "returns" (T,), không dính đồ thị gradient;
      obs: trạng thái hiện tại sau T bước (để lần gọi sau chạy tiếp);
      episode_returns: list tổng reward của các episode kết thúc trong rollout này."""
    raise NotImplementedError
