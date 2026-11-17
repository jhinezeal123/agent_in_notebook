# %% [markdown]
# **Thuật toán sinh ảnh bắt đầu từ đâu?** Alg. 2 mở đầu bằng $x_T \sim \mathcal N(0, \mathbf I)$: một nắm nhiễu thuần túy. Nhưng thứ mô hình đã học là đảo ngược quá trình thuận, mà quá trình thuận *thật* kết thúc ở $x_T = \sqrt{\bar\alpha_T}\,x_0 + \sqrt{1-\bar\alpha_T}\,\varepsilon$. Hai thứ này chỉ trùng nhau khi $\bar\alpha_T \approx 0$.
#
# Hình trái: $\bar\alpha_t$ theo $t$ cho ba lịch nhiễu tuyến tính: paper ($T = 1000$, $\beta$ từ $10^{-4}$ đến $0{,}02$), cùng khoảng $\beta$ đó nhưng chỉ $T = 200$ bước, và $T = 200$ với $\beta$ co giãn cho bù (nhân 5). Hình phải: giá trị một pixel của ảnh đã nhiễu tới bước cuối $x_{T}$, trên dữ liệu đồ chơi giống chữ số (80% pixel là nền $-1$, 20% là nét $+1$), so với phân phối $\mathcal N(0,1)$ mà vòng lấy mẫu bắt đầu từ đó. Chú ý: lịch nào làm hai đường chồng khít nhau, và lịch nào còn "nhớ" ảnh gốc?

# %%
import numpy as np
import matplotlib.pyplot as plt

schedules = {
    "T = 1000, β: 1e-4 → 0.02 (paper)": (1000, 1e-4, 0.02),
    "T = 200, β: 1e-4 → 0.02": (200, 1e-4, 0.02),
    "T = 200, β: 5e-4 → 0.1": (200, 5e-4, 0.1),
}
rng = np.random.default_rng(0)
x0 = np.where(rng.random(200_000) < 0.8, -1.0, 1.0)      # pixel của ảnh đồ chơi
eps = rng.standard_normal(x0.shape)

fig, ax = plt.subplots(1, 2, figsize=(10, 3.4))
bins = np.linspace(-4, 4, 80)
ax[1].plot(bins, np.exp(-bins ** 2 / 2) / np.sqrt(2 * np.pi), "k--", label="N(0, 1): nơi Alg. 2 bắt đầu")
for name, (T, b0, b1) in schedules.items():
    ab = np.cumprod(1 - np.linspace(b0, b1, T))
    ax[0].semilogy(np.arange(T) / (T - 1), ab, label=name)
    xT = np.sqrt(ab[-1]) * x0 + np.sqrt(1 - ab[-1]) * eps
    ax[1].hist(xT, bins=bins, density=True, histtype="step", label=f"{name}: ᾱ_T = {ab[-1]:.1e}")
ax[0].set_xlabel("t / (T - 1)"); ax[0].set_ylabel("ᾱ_t (thang log)"); ax[0].legend(fontsize=7)
ax[1].set_xlabel("giá trị một pixel của x_T"); ax[1].legend(fontsize=6)
plt.tight_layout()
plt.show()

# %% [markdown]
# **Dự đoán trước khi code** (rồi kiểm lại bằng hình): với lịch thứ hai ($T = 200$, $\beta$ giữ nguyên như paper), ảnh $x_T$ của quá trình thuận còn bao nhiêu phần trăm biên độ của ảnh gốc, và nếu vòng lấy mẫu vẫn bắt đầu từ $\mathcal N(0,\mathbf I)$ thì mô hình sẽ nhìn thấy gì ở bước đầu tiên mà nó chưa từng gặp khi train? Điều đó nhắc bạn kiểm gì ở lịch nhiễu khi đổi $T$ ở thí nghiệm cuối.
