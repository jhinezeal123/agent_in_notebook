def lambda_return(rewards, values, dones, last_value, gamma, lam):
    """lambda-return: G_t = r_t + gamma * (1 - d_t) * ((1 - lam) * V_(t+1) + lam * G_(t+1)), V_T = G_T = last_value.
    rewards, values, dones: (T,) float32 (dones[t] = 1.0: episode kết thúc ngay sau bước t); last_value: số thực hoặc tensor 0 chiều;
    values có thể đang có gradient: kết quả không được dính đồ thị. Trả về tensor (T,) float32; không sửa đầu vào.
    Phải bằng returns mà compute_gae trả về."""
    raise NotImplementedError
