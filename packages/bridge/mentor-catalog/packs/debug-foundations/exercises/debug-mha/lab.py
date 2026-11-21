# %% [markdown]
# # Chẩn đoán triệu chứng: reshape thẳng (B, H, T, dh) phá vỡ thứ tự token
# Với 1 chuỗi có $T=4$ token và $D=4$ chia thành $H=2$ head ($d_h=2$), mỗi token mang mã màu là chỉ số thời gian của chính nó.

# %%
import numpy as np
import matplotlib.pyplot as plt

B, T, D, H = 1, 4, 4, 2
dh = D // H
# Mỗi hàng t chứa số t lặp lại trên D cột để nhìn rõ token nào đi đâu
tokens = np.repeat(np.arange(T)[None, :, None], D, axis=2)
buggy = tokens.reshape(B, H, T, dh)[0]
right = tokens.reshape(B, T, H, dh).transpose(0, 2, 1, 3)[0]

fig, ax = plt.subplots(1, 2, figsize=(7, 3))
ax[0].imshow(buggy[0], vmin=0, vmax=3)
ax[0].set_title("Head 0 (reshape thẳng → bị trộn token!)")
ax[1].imshow(right[0], vmin=0, vmax=3)
ax[1].set_title("Head 0 (reshape + transpose → giữ đủ 0,1,2,3)")
plt.tight_layout()
plt.show()
