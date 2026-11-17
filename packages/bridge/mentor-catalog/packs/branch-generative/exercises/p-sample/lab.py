# %% [markdown]
# **Hai cách chọn σ trong Alg. 2.** Ở §3.2 paper nói hai lựa chọn cho độ lệch chuẩn của nhiễu thêm vào mỗi bước đều cho kết quả tương tự: $\sigma_t^2=\beta_t$ (bài này dùng) và $\sigma_t^2=\tilde\beta_t$ với $\tilde\beta_t=\dfrac{1-\bar\alpha_{t-1}}{1-\bar\alpha_t}\,\beta_t$ là **phương sai thật của hậu nghiệm** $q(x_{t-1}\mid x_t,x_0)$ (Eq. 7). Ta dùng chỉ số từ 0 như mọi bài ở sao này, với $\bar\alpha_{-1}:=1$ (chưa có bước nào). Hình dưới vẽ cả hai theo bước (trục dọc log), với lịch tuyến tính $T=1000$.
#
# Đọc hình: hai đường sát nhau ở hầu hết các bước, nhưng chúng khác nhau rõ ở đầu chuỗi. Ở chỉ số 0, $\tilde\beta$ bằng bao nhiêu? Điều đó nói gì về việc có nên thêm nhiễu ở bước cuối cùng?

# %%
import numpy as np
import matplotlib.pyplot as plt

T = 1000
beta = np.linspace(1e-4, 0.02, T)
alpha = 1 - beta
ab = np.cumprod(alpha)
ab_prev = np.concatenate([[1.0], ab[:-1]])
beta_tilde = (1 - ab_prev) / (1 - ab) * beta
print("β̃ ở các chỉ số 0, 1, 2, 3:", beta_tilde[:4], "| β ở các chỉ số 0, 1, 2, 3:", beta[:4])

fig, ax = plt.subplots(1, 2, figsize=(9.5, 3.4))
ax[0].semilogy(np.arange(T), beta, label="β_t")
ax[0].semilogy(np.arange(1, T), beta_tilde[1:], "--", label="β̃_t (từ chỉ số 1)")
ax[0].set_xlabel("chỉ số bước t (từ 0)")
ax[0].set_ylabel("phương sai σ²")
ax[0].legend(fontsize=8)
ax[1].plot(np.arange(1, 60), (beta_tilde / beta)[1:60])
ax[1].set_xlabel("chỉ số bước t (từ 0)")
ax[1].set_ylabel("β̃_t / β_t")
plt.tight_layout()
plt.show()

# %% [markdown]
# **Mỗi bước reverse chỉnh bao nhiêu, và "lắc" bao nhiêu?** Ở mỗi bước $t$, đóng góp của dự đoán nhiễu vào $x_{t-1}$ là $\dfrac{\beta_t}{\sqrt{\alpha_t}\sqrt{1-\bar\alpha_t}}\,\varepsilon_\theta$ (một nhiễu cỡ 1 thì kéo $x$ đi chừng đó, nhìn phần "chỉnh"); phần "lắc" ngẫu nhiên là $\sigma_t z$ có độ lớn $\sqrt{\beta_t}$. Hình dưới vẽ hai độ lớn này theo $t$ (trục log). Nhìn hình: cái nào lớn hơn, và ở đầu chuỗi (chỉ số nhỏ) hai cái gần nhau cỡ nào? Vậy nếu ở bước cuối ta vẫn lắc, độ lệch còn lại trên ảnh cuối là cỡ bao nhiêu so với phần chỉnh?

# %%
correct = beta / (np.sqrt(alpha) * np.sqrt(1 - ab))
shake = np.sqrt(beta)
fig, ax = plt.subplots(figsize=(5.4, 3.3))
ax.semilogy(correct, label="phần chỉnh (hệ số của ε_θ)")
ax.semilogy(shake, label="phần lắc σ_t = √β_t")
ax.set_xlabel("chỉ số bước t (từ 0)")
ax.set_ylabel("độ lớn mỗi phần")
ax.legend(fontsize=8)
plt.tight_layout()
plt.show()
print(f"chỉ số 0: chỉnh {correct[0]:.4f}, lắc {shake[0]:.4f}; chỉ số {T-1}: chỉnh {correct[-1]:.4f}, lắc {shake[-1]:.4f}")
