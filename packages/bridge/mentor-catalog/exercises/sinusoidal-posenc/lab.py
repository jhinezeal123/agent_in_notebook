# %% [markdown]
# Attention không biết thứ tự: hoán vị các token thì output hoán vị theo, không hơn. Muốn mô hình biết "token này đứng thứ mấy", ta **cộng** vào embedding một vector chỉ phụ thuộc vị trí.
#
# Ý tưởng của bài báo: mỗi cặp chiều là **một kim đồng hồ** quay với tốc độ $\omega_i$; vị trí `pos` là góc $\text{pos}\cdot\omega_i$, và cặp chiều lưu $(\sin, \cos)$ của góc đó. Kim nhanh phân biệt các vị trí gần nhau, kim chậm phân biệt các vị trí xa nhau, giống các chữ số của một bộ đếm.

# %%
import numpy as np
import matplotlib.pyplot as plt

d = 64
pairs = np.arange(d // 2)
omega = 1.0 / 10000.0 ** (2 * pairs / d)

fig, ax = plt.subplots(1, 2, figsize=(11, 3.2))
ax[0].semilogy(pairs, omega, "o-", ms=3)
ax[0].set_xlabel("chỉ số cặp i")
ax[0].set_title("tốc độ quay ω_i (thang log)")
ax[1].semilogy(pairs, 2 * np.pi / omega, "o-", ms=3, color="C1")
ax[1].set_xlabel("chỉ số cặp i")
ax[1].set_title("bước sóng 2π/ω_i: từ 2π tới 10000·2π")
plt.tight_layout()
plt.show()

# %% [markdown]
# Mỗi kim là một sóng theo `pos`. Dưới đây là sin của vài cặp: cặp đầu dao động nhanh, cặp cuối gần như đứng yên trong 100 vị trí đầu.

# %%
pos = np.arange(100)
plt.figure(figsize=(10, 3.2))
for i in [0, 4, 10, 20, 31]:
    plt.plot(pos, np.sin(pos * omega[i]) + 2.5 * (i // 5), label=f"cặp {i}")
plt.xlabel("pos")
plt.yticks([])
plt.legend(loc="upper right", fontsize=8)
plt.title("sin(pos·ω_i) của vài cặp (dịch dọc cho dễ nhìn)")
plt.show()

# %% [markdown]
# Ghép mọi kim lại thành bản đồ nhiệt: hàng là vị trí, cột là cặp chiều. Hai nửa dưới đây là phần sin và phần cos; trong bài làm bạn phải **xếp xen kẽ** chúng vào các cột chẵn/lẻ.

# %%
angle = pos[:, None] * omega[None, :]
fig, ax = plt.subplots(1, 2, figsize=(11, 4), sharey=True)
ax[0].imshow(np.sin(angle), aspect="auto", cmap="RdBu_r", vmin=-1, vmax=1)
ax[0].set_title("sin(pos·ω_i)")
ax[1].imshow(np.cos(angle), aspect="auto", cmap="RdBu_r", vmin=-1, vmax=1)
ax[1].set_title("cos(pos·ω_i)")
for a in ax:
    a.set_xlabel("cặp i")
ax[0].set_ylabel("pos")
plt.tight_layout()
plt.show()

# %% [markdown]
# **Tích vô hướng theo khoảng cách.** Với một cặp: $\sin a \sin b + \cos a \cos b = \cos(a - b)$. Cộng qua các cặp:
#
# $$PE[p] \cdot PE[q] = \sum_i \cos\big((p - q)\,\omega_i\big)$$
#
# chỉ phụ thuộc **khoảng cách** $p - q$, không phụ thuộc $p$. Hình trái: đường cong theo khoảng cách $k$. Hình phải: ma trận $PE \cdot PE^\top$ — mọi đường chéo song song là hằng số. Sau khi viết xong bài, hãy tự vẽ lại hình phải bằng hàm của bạn.

# %%
k = np.arange(-100, 101)
dots = np.cos(k[:, None] * omega[None, :]).sum(1)
gram = np.cos((pos[:, None, None] - pos[None, :, None]) * omega).sum(-1)
fig, ax = plt.subplots(1, 2, figsize=(11, 3.8))
ax[0].plot(k, dots)
ax[0].set_xlabel("khoảng cách k")
ax[0].set_title("PE[p]·PE[p+k] (cực đại d/2 tại k = 0)")
im = ax[1].imshow(gram, cmap="viridis")
ax[1].set_xlabel("q")
ax[1].set_ylabel("p")
ax[1].set_title("PE·PEᵀ")
plt.colorbar(im, ax=ax[1])
plt.tight_layout()
plt.show()
