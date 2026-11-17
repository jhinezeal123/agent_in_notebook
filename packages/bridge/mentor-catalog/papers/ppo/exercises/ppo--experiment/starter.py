# Cell train. Chạy xong cell này, biến toàn cục `policy` phải giữ một ActorCritic đã train bằng PPO, trên CPU.
torch.manual_seed(0)
generator = torch.Generator().manual_seed(0)

# 1. Dựng: CartPole() (reset(seed=...) một lần để có obs đầu), policy = ActorCritic(), optimizer Adam cho mọi tham số của policy.
env = ...
policy = ...

# 2. Vòng lặp PPO (khoảng 50 vòng). Mỗi vòng: collect_rollout (T = 1024 bước, nhớ nhận lại obs để chạy tiếp)
#    -> chuẩn hóa advantage của batch (từ ngoài ppo_update) -> ppo_update.
#    Gợi ý: ghi lại return trung bình của các episode kết thúc trong mỗi vòng để vẽ.
...

# 3. Xem thử: plot_returns(danh sách return theo vòng); evaluate(...) cho policy lấy mẫu và cho policy tham lam, seed 10_000.
...
