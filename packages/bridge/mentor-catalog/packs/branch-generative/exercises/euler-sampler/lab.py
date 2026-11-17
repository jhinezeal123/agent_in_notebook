# %% [markdown]
# **Một bước Euler là đi theo tiếp tuyến.** Lấy trường vận tốc đơn giản nhất mà ta biết nghiệm: $\dfrac{dx}{dt}=v(x,t)=-x$, nghiệm chính xác từ $x(0)=x_0$ là $x_0e^{-t}$. Hình dưới vẽ trường (các mũi tên là hướng $v$ tại mỗi điểm $(t,x)$), vài nghiệm chính xác (đường xanh), và **một** bước Euler từ điểm $(t=0.2,\ x=1.5)$ với $\Delta t=0.4$: đoạn đỏ là tiếp tuyến **đo ở điểm xuất phát** của bước, dài $\Delta t$ theo trục thời gian. Đường xanh đứt là nghiệm thật đi qua cùng điểm xuất phát.
#
# Đọc hình: cuối bước, đoạn đỏ nằm trên hay dưới nghiệm thật, và cách bao xa? Vì sao nó lệch? (Tiếp tuyến chỉ đúng ở điểm nào?) Thử tưởng tượng chia bước dài $0.4$ làm hai bước ngắn: sai số mỗi bước ngắn so với bước dài thế nào?

# %%
import numpy as np
import matplotlib.pyplot as plt

v = lambda x, t: -x
tt, xx = np.meshgrid(np.linspace(0, 1, 11), np.linspace(-2, 2, 9))
t0, x_a, dt = 0.2, 1.5, 0.4

fig, ax = plt.subplots(figsize=(6.2, 3.8))
ax.quiver(tt, xx, np.ones_like(tt), v(xx, tt), angles="xy", color="lightgray", width=0.003)
grid = np.linspace(0, 1, 100)
for x_start in (-1.5, -0.5, 0.5, 1.5):
    ax.plot(grid, x_start * np.exp(-grid), color="tab:blue", alpha=0.5, lw=1)
ax.plot(grid[grid >= t0], x_a * np.exp(-(grid[grid >= t0] - t0)), "--", color="tab:blue", lw=1.6, label="nghiệm thật từ điểm xuất phát")
ax.plot([t0, t0 + dt], [x_a, x_a + dt * v(x_a, t0)], color="tab:red", lw=2.2, label="một bước Euler (tiếp tuyến ở đầu bước)")
ax.scatter([t0], [x_a], color="k", zorder=3)
ax.set_xlabel("thời gian t")
ax.set_ylabel("vị trí x")
ax.legend(fontsize=8, loc="lower left")
plt.tight_layout()
plt.show()

# %% [markdown]
# **Sai số một bước theo độ dài bước.** Hình dưới đo, với cùng điểm xuất phát, độ lệch giữa một bước Euler và nghiệm thật theo độ dài bước $\Delta t$ (cả hai trục log). Hai đường gạch là các đường tham chiếu $\propto\Delta t$ và $\propto\Delta t^2$; số in ra là độ dốc đo được của đường sai số.
#
# Đọc hình: sai số **một bước** tỉ lệ với luỹ thừa nào của $\Delta t$? Nếu để đi hết đoạn $[0,1]$ ta cần $N=1/\Delta t$ bước và sai số các bước cộng dồn, thì sai số **tổng** tỉ lệ với luỹ thừa nào của $\Delta t$? Từ đó, gấp đôi số bước thì sai số cuối giảm khoảng mấy lần?

# %%
x_a = 1.5
dts = np.logspace(-3, -0.3, 30)
err = np.abs(x_a * np.exp(-dts) - (x_a + dts * v(x_a, 0.0)))
slope = np.polyfit(np.log(dts), np.log(err), 1)[0]
print(f"độ dốc của sai số một bước theo dt (log-log): {slope:.2f}")

fig, ax = plt.subplots(figsize=(5.2, 3.4))
ax.loglog(dts, err, "o-", ms=3, label="sai số một bước Euler")
ax.loglog(dts, 0.5 * dts, "--", color="gray", label="∝ dt")
ax.loglog(dts, 0.5 * dts**2 * x_a, ":", color="gray", label="∝ dt²")
ax.set_xlabel("độ dài bước dt")
ax.set_ylabel("sai số sau một bước")
ax.legend(fontsize=8)
plt.tight_layout()
plt.show()
