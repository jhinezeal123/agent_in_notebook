# %% [markdown]
# **Autograd tính đạo hàm cho bạn.** Đặt `requires_grad=True` cho một tensor lá, tính tiếp bất cứ thứ gì từ nó, PyTorch ghi lại đồ thị phép tính; gọi `.backward()` trên một số vô hướng thì đạo hàm được **cộng vào** `.grad` của các tensor lá. Ở đây $f(x) = x \sin x$ tại 200 điểm cùng lúc: vì mỗi $f(x_i)$ chỉ phụ thuộc $x_i$, đạo hàm của $\sum_i f(x_i)$ theo $x_i$ chính là $f'(x_i)$.

# %%
import numpy as np
import torch
import matplotlib.pyplot as plt

x = torch.linspace(-6, 6, 200, requires_grad=True)
y = x * torch.sin(x)
y.sum().backward()

xs = x.detach().numpy()
plt.figure(figsize=(7, 3.2))
plt.plot(xs, y.detach().numpy(), label="f(x) = x sin x")
plt.plot(xs, x.grad.numpy(), label="x.grad (autograd)")
plt.plot(xs[::10], (np.sin(xs) + xs * np.cos(xs))[::10], "k.", label="sin x + x cos x (tính tay)")
plt.axhline(0, color="gray", lw=0.5)
plt.legend(fontsize=8); plt.tight_layout()
plt.show()

# %% [markdown]
# **`.grad` cộng dồn, không ghi đè.** Gọi `backward` 5 lần cho cùng một loss $L = 3w$: nếu không xoá `.grad` giữa các lần, giá trị cứ tăng 3, 6, 9… Đó là lý do vòng lặp train phải xoá gradient mỗi bước, và là lý do một hàm "chỉ muốn đọc gradient" mà gọi `backward` sẽ để lại dấu vết trên tham số của người gọi.

# %%
w = torch.tensor(1.0, requires_grad=True)
seen_accum, seen_reset = [], []
for _ in range(5):
    (3 * w).backward()
    seen_accum.append(float(w.grad))
w.grad = None
for _ in range(5):
    w.grad = None
    (3 * w).backward()
    seen_reset.append(float(w.grad))

steps = np.arange(1, 6)
plt.figure(figsize=(6, 3))
plt.bar(steps - 0.2, seen_accum, width=0.4, label="không xoá .grad")
plt.bar(steps + 0.2, seen_reset, width=0.4, label="xoá .grad trước mỗi lần")
plt.xlabel("lần gọi backward"); plt.ylabel("w.grad"); plt.legend(fontsize=8)
plt.tight_layout()
plt.show()

# %% [markdown]
# **Chặn gradient.** Với $L = (a - b)^2$, gradient chảy vào cả $a$ lẫn $b$ (ngược dấu nhau). Nếu $b$ là "đáp án" do một mạng khác đưa ra, ta chỉ muốn kéo $a$ về phía $b$, không kéo $b$ về phía $a$. `detach()` trả về một tensor cùng giá trị nhưng đã bị cắt khỏi đồ thị.

# %%
rows = []
for label, cut in [("(a − b)²", False), ("(a − b.detach())²", True)]:
    a = torch.tensor(2.0, requires_grad=True)
    b = torch.tensor(-1.0, requires_grad=True)
    other = b.detach() if cut else b
    ((a - other) ** 2).backward()
    rows.append((label, float(a.grad), 0.0 if b.grad is None else float(b.grad)))

fig, ax = plt.subplots(figsize=(6, 3))
for i, (label, ga, gb) in enumerate(rows):
    ax.bar([i - 0.2], [ga], width=0.4, color="tab:blue", label="dL/da" if i == 0 else None)
    ax.bar([i + 0.2], [gb], width=0.4, color="tab:orange", label="dL/db" if i == 0 else None)
ax.set_xticks([0, 1]); ax.set_xticklabels([r[0] for r in rows])
ax.axhline(0, color="gray", lw=0.5); ax.legend(fontsize=8)
plt.tight_layout()
plt.show()
