# %% [markdown]
# **RNN một chiều (vô hướng).** Để thấy bản chất, thu RNN về một con số: $h_t = \tanh(w\,h_{t-1} + u\,x_t)$. Cho một "xung" ở bước đầu ($x_1 = 1$, các bước sau bằng 0) rồi xem trạng thái nhớ xung đó bao lâu, với các giá trị $w$ khác nhau.

# %%
import numpy as np
import matplotlib.pyplot as plt

def scalar_rnn(xs, w, u, h=0.0):
    out = []
    for v in xs:
        h = np.tanh(w * h + u * v)
        out.append(h)
    return np.array(out)

T = 40
pulse = np.zeros(T); pulse[0] = 1.0
plt.figure(figsize=(7, 3.2))
for w in [0.5, 0.9, 1.0, 1.5]:
    plt.plot(scalar_rnn(pulse, w, u=1.0), label=f"w = {w}")
plt.axhline(0, color="gray", lw=0.5)
plt.xlabel("bước t"); plt.ylabel("h_t"); plt.legend()
plt.title("Trí nhớ về xung ở bước 0")
plt.tight_layout()
plt.show()

# %% [markdown]
# **Ảnh hưởng của đầu vào xa.** Đạo hàm $\partial h_T / \partial x_1$ là tích của $T$ thừa số $w \cdot (1 - h_t^2)$. Đo nó bằng sai phân hữu hạn trên chuỗi ngẫu nhiên: nếu $|w|$ nhỏ, ảnh hưởng **tắt theo cấp số nhân**; tanh bão hoà cũng làm nó tắt. Đây là gốc rễ của vanishing gradient trong RNN.

# %%
rng = np.random.default_rng(0)
xs = rng.normal(size=60) * 0.5
eps = 1e-6
fig = plt.figure(figsize=(7, 3.2))
for w in [0.5, 1.0, 2.0, 4.0]:
    sens = []
    for L in range(1, 60):
        bumped = xs[:L].copy(); bumped[0] += eps
        sens.append(abs(scalar_rnn(bumped, w, 1.0)[-1] - scalar_rnn(xs[:L], w, 1.0)[-1]) / eps + 1e-18)
    plt.semilogy(range(1, 60), sens, label=f"w = {w}")
plt.xlabel("độ dài chuỗi T"); plt.ylabel("|∂h_T / ∂x_1|"); plt.legend()
plt.title("Bước đầu tiên ảnh hưởng tới trạng thái cuối bao nhiêu")
plt.tight_layout()
plt.show()

# %% [markdown]
# **Thứ tự quan trọng.** Cùng một tập giá trị đầu vào, chỉ đổi thứ tự, trạng thái cuối khác hẳn. Tổng (kiểu "bag of words") thì không phân biệt được.

# %%
seq = np.array([2.0, -1.0, 0.5, -2.0, 1.5])
orders = [seq, seq[::-1], np.sort(seq), rng.permutation(seq)]
names = ["gốc", "đảo ngược", "sắp xếp", "xáo trộn"]
fig, ax = plt.subplots(1, 2, figsize=(10, 3))
ax[0].bar(names, [scalar_rnn(s, 0.8, 1.0)[-1] for s in orders], color="tab:green"); ax[0].set_title("h_T của RNN")
ax[1].bar(names, [s.sum() for s in orders], color="tab:gray"); ax[1].set_title("tổng các đầu vào")
plt.tight_layout()
plt.show()

# %% [markdown]
# **Từ vô hướng sang ma trận.** Trong bài làm, $w$ thành ma trận `Wh` $(d_h, d_h)$, $u$ thành `Wx` $(d_{in}, d_h)$, và mỗi bước xử lý cả batch. Điền shape cho từng đại lượng trong phần phác thảo:

# %%
for name, shape in [("x", "(B, T, d_in)"), ("x_t", "?"), ("h_{t-1}", "?"), ("x_t Wx", "?"), ("h_{t-1} Wh", "?"), ("b", "(d_h,)"), ("hs", "(B, T, d_h)")]:
    print(f"{name:>12}: {shape}")
