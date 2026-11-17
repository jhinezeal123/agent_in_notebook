# %% [markdown]
# **Huber hay MSE?** Sai số TD $x = Q(s,a) - y$ có thể rất lớn ở đầu quá trình học (target còn nhiễu, thưởng lớn). Hình trái là hai loss theo $x$; hình phải là **gradient** của chúng. Quan sát: gradient của MSE tăng tuyến tính theo $x$ (sai số lớn kéo mạng rất mạnh), còn gradient của Huber bị chặn ở $\pm 1$. Trước khi code, đoán: với một transition có sai số 20, MSE đẩy gradient mạnh gấp mấy lần Huber, và vì sao điều đó nguy hiểm khi target chính nó cũng nhiễu?

# %%
import numpy as np
import matplotlib.pyplot as plt

x = np.linspace(-4, 4, 401)
mse = 0.5 * x ** 2
huber = np.where(np.abs(x) < 1, 0.5 * x ** 2, np.abs(x) - 0.5)
grad_mse = x
grad_huber = np.clip(x, -1, 1)

fig, axes = plt.subplots(1, 2, figsize=(9, 3.4))
axes[0].plot(x, mse, label="MSE (1/2 x²)")
axes[0].plot(x, huber, label="Huber")
axes[0].set_xlabel("sai số TD  x = Q(s,a) - y")
axes[0].set_ylabel("loss")
axes[0].set_ylim(0, 8)
axes[0].legend()
axes[1].plot(x, grad_mse, label="gradient của MSE")
axes[1].plot(x, grad_huber, label="gradient của Huber")
axes[1].set_xlabel("sai số TD  x")
axes[1].set_ylabel("d loss / d x")
axes[1].legend()
plt.tight_layout()
plt.show()
print("sai số 20: gradient MSE =", 20.0, "| gradient Huber =", float(np.clip(20.0, -1, 1)))

# %% [markdown]
# **Hai thao tác trục.** Mạng cho ra một bảng `Q` kích thước `(B, A)`: mỗi hàng là một transition, mỗi cột là một hành động. Hình dưới là bảng ngẫu nhiên với `B = 5`, `A = 4`. Trái: bảng $Q_\theta(s)$ của mạng chính, ô đỏ là **hành động đã chọn** của từng hàng (đúng một ô mỗi hàng; đây là con số đi vào loss). Phải: bảng $Q_{\bar\theta}(s')$ của mạng target, ô xanh là **giá trị lớn nhất của mỗi hàng** (đi vào target). Nhìn hai hình và trả lời: thao tác nào chạy theo trục hàng, thao tác nào theo trục cột, và kết quả mỗi thao tác có shape gì?

# %%
gen = np.random.default_rng(1)
q_main = np.round(gen.normal(0, 2, size=(5, 4)), 1)
q_target = np.round(gen.normal(0, 2, size=(5, 4)), 1)
chosen = np.array([2, 0, 3, 1, 1])
mark_chosen = np.arange(4)[None, :] == chosen[:, None]
mark_best = q_target == q_target.max(axis=1, keepdims=True)

fig, axes = plt.subplots(1, 2, figsize=(9, 3.6))
for ax, table, mark, color, title in [
    (axes[0], q_main, mark_chosen, "tab:red", "Q của mạng chính: ô đỏ = hành động đã chọn"),
    (axes[1], q_target, mark_best, "tab:blue", "Q của mạng target: ô xanh = lớn nhất mỗi hàng"),
]:
    ax.imshow(np.where(mark, 1.0, 0.0), cmap=plt.cm.Reds if color == "tab:red" else plt.cm.Blues, vmin=0, vmax=1.6)
    for i in range(5):
        for j in range(4):
            ax.text(j, i, f"{table[i, j]:.1f}", ha="center", va="center", fontsize=11)
    ax.set_xticks(range(4))
    ax.set_xticklabels([f"a={j}" for j in range(4)])
    ax.set_yticks(range(5))
    ax.set_yticklabels([f"i={i}" for i in range(5)])
    ax.set_title(title, fontsize=9)
plt.tight_layout()
plt.show()

# %% [markdown]
# **Vì sao có hai mạng, và vì sao target không nhận gradient?** Nếu target tính bằng chính mạng đang học, mỗi lần cập nhật làm đổi cả $Q_\theta(s_i)[a_i]$ lẫn mục tiêu $y_i$ của nó: bạn đuổi theo cái bóng của chính mình. Mạng target là bản sao cũ, đứng yên giữa các lần đồng bộ, nên mục tiêu ổn định trong một lúc. Còn nếu cứ để gradient chảy qua $y$, bạn tối ưu một loss khác hẳn (đẩy cả target về phía dự đoán). Tự hỏi: ở đầu huấn luyện, khi hai mạng vừa được đồng bộ (giống hệt nhau), loss tính bằng `q_net` thay cho `target_net` cho cùng một con số, vậy tại sao vẫn sai?
