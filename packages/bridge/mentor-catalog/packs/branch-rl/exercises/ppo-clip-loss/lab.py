# %% [markdown]
# **Hai ứng viên cho mỗi mẫu.** Với một mẫu có advantage $A$ và tỉ số xác suất $r$, PPO có hai con số: $r\cdot A$ (con số "thô") và $\operatorname{clip}(r, 1-\epsilon, 1+\epsilon)\cdot A$ (con số bị ép $r$ vào đoạn hẹp quanh 1). Loss lấy **một trong hai** ở mỗi mẫu (cái bi quan hơn, tức nhỏ hơn). Hình dưới vẽ **cả hai ứng viên** theo $r$ với $\epsilon = 0.2$, một hình cho $A = +1$ và một hình cho $A = -1$ (nét liền: $rA$; nét đứt: $\operatorname{clip}(r)\,A$; hai đường dọc đỏ: $1\pm\epsilon$). Trước khi code: ở mỗi hình, với $r$ nằm ở bên trái, ở giữa, ở bên phải hai vạch đỏ, đường nào **thấp hơn**? Và nơi mà đường đứt là đường thấp hơn (hoặc nằm ngang), độ dốc theo $r$ của giá trị được chọn là bao nhiêu (gradient còn chảy không)? Chú ý: hình $A = -1$ không phải là hình $A = +1$ lật gương.

# %%
import numpy as np
import matplotlib.pyplot as plt

eps = 0.2
r = np.linspace(0.2, 1.8, 400)
fig, axes = plt.subplots(1, 2, figsize=(10, 3.8), sharex=True)
for ax, a in zip(axes, [1.0, -1.0]):
    ax.plot(r, r * a, label="r * A")
    ax.plot(r, np.clip(r, 1 - eps, 1 + eps) * a, "--", label="clip(r) * A")
    ax.axvline(1 - eps, color="red", lw=1)
    ax.axvline(1 + eps, color="red", lw=1)
    ax.axvline(1.0, color="gray", lw=0.8, ls=":")
    ax.set_xlabel("r = pi_new / pi_old")
    ax.set_ylabel("giá trị mẫu")
    ax.set_title(f"A = {a:+.0f}")
    ax.legend()
plt.tight_layout()
plt.show()

# %% [markdown]
# **Tỉ số sống trong không gian log.** Thực tế bạn có `new_logp` và `old_logp` (log-xác suất), không phải xác suất. Hình dưới: tỉ số $r = e^{\Delta}$ theo hiệu $\Delta = \text{new\_logp} - \text{old\_logp}$ (trái), và dải $[1-\epsilon, 1+\epsilon]$ nằm ở đâu trên trục $\Delta$ (vùng tô, phải, với ba giá trị $\epsilon$). Câu hỏi: dải cắt hẹp cỡ bao nhiêu theo $\Delta$? Và nếu `new_logp = -120` và `old_logp = -121` (xác suất cỡ $10^{-52}$), tính $e^{-120}/e^{-121}$ trong float32 cho ra gì, còn $e^{\Delta}$ thì sao?

# %%
delta = np.linspace(-1.0, 1.0, 400)
fig, axes = plt.subplots(1, 2, figsize=(10, 3.6))
axes[0].plot(delta, np.exp(delta))
axes[0].axhline(1.0, color="gray", lw=0.8, ls=":")
axes[0].set_xlabel("Delta = new_logp - old_logp")
axes[0].set_ylabel("r = exp(Delta)")
for e, c in zip([0.1, 0.2, 0.3], ["tab:green", "tab:blue", "tab:orange"]):
    lo, hi = np.log(1 - e), np.log(1 + e)
    axes[1].barh(e, hi - lo, left=lo, height=0.06, color=c, alpha=0.8)
    axes[1].text(hi + 0.02, e, f"[{lo:.2f}, {hi:.2f}]", va="center", fontsize=9)
axes[1].set_yticks([0.1, 0.2, 0.3])
axes[1].set_xlim(-0.6, 0.7)
axes[1].set_xlabel("Delta")
axes[1].set_ylabel("eps")
axes[1].set_title("dải [1-eps, 1+eps] trên trục Delta")
plt.tight_layout()
plt.show()
with np.errstate(all="ignore"):
    tiny = np.float32(-120.0)
    print("float32: exp(-120) / exp(-121) =", np.exp(tiny) / np.exp(np.float32(-121.0)), "| exp(-120 - (-121)) =", float(np.exp(tiny - np.float32(-121.0))))
