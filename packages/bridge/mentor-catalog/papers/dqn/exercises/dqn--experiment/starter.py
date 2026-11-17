# Cell train. Chạy xong cell này, biến toàn cục `q_net` phải giữ mạng Q (QNet của bạn) đã train bằng DQN, trên CPU.
torch.manual_seed(0)
rng = np.random.default_rng(0)

# 1. Dựng: CartPole(), q_net = QNet(), target_net (chép cứng từ q_net lúc đầu bằng sync_target), optimizer Adam, buffer ReplayBuffer.
env = ...
q_net = ...

# 2. Vòng train (khoảng 20 000 bước môi trường). Mỗi bước: eps theo lịch -> select_action -> env.step -> buffer.push (cờ done là
#    cờ kết thúc thật, không phải truncated) -> reset khi hết episode -> dqn_train_step (sau ~500 bước đầu) -> sync_target đúng lúc.
#    Ghi lại return từng episode vào một danh sách để vẽ. Mỗi 1 000 bước: đo chính sách tham lam bằng evaluate (5 episode, seed riêng),
#    giữ bản sao state_dict tốt nhất; hết vòng thì nạp lại vào q_net.
...

# 3. Xem thử: plot_returns(danh sách return); evaluate(lambda obs: ..., 20, seed=10_000) cho chính sách tham lam của q_net.
...
