# %% [markdown]
# # Lần theo shape và bất biến toán học
# Khi đọc code tensor của người khác (hoặc trong paper), thay vì chạy thử mù quáng, ta ghi shape ở cuối mỗi dòng và kiểm tra các tính chất đại số (tổng, độ lớn, bất biến tịnh tiến).

# %%
import numpy as np
import matplotlib.pyplot as plt

rng = np.random.default_rng(7)
B, T, D = 2, 6, 4
X = rng.normal(size=(B, T, D))
mask = np.array([[1, 1, 1, 1, 0, 0], [1, 1, 0, 0, 0, 0]], dtype=bool)
w, mu, R, out = mystery_block_a(X, mask)
print("Ví dụ B=2, T=6, D=4 -> shapes:", w.shape, mu.shape, R.shape, out.shape)

fig, ax = plt.subplots(1, 2, figsize=(7, 2.8))
ax[0].imshow(X[0], aspect="auto")
ax[0].set_title("X[0] trước xử lý (6 token × 4 chiều)")
ax[1].imshow(R[0], aspect="auto")
ax[1].set_title("R[0] sau mystery_block_a (2 token cuối bị mask)")
plt.tight_layout()
plt.show()
