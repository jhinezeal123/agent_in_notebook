# %% [markdown]
# **Teacher forcing: decoder nhận chuỗi đích lệch một vị trí.** Với câu nguồn `3 1 4` và đáp án `4 1 3`, đưa vào decoder `tgt_in = < 4 1 3` (bắt đầu bằng `<` là BOS) và bắt nó đoán `tgt_out = 4 1 3 >` (kết thúc bằng `>` là EOS). Mỗi cột là một cặp "token đang thấy → token phải đoán": vị trí $t$ của `tgt_in` chỉ được dùng để đoán vị trí $t$ của `tgt_out`, và mask causal cấm nó nhìn các cột bên phải.
#
# **Mask của một batch có PAD.** Hai câu nguồn dài khác nhau được đệm (PAD) cho cùng độ dài. Hàng là câu trong batch, cột là vị trí; ô xanh là token thật.

# %%
import numpy as np
import matplotlib.pyplot as plt

PAD, BOS, EOS, D0 = 0, 1, 2, 3
src = [3 + 3, 3 + 1, 3 + 4]
tgt_out = src[::-1] + [EOS]
tgt_in = [BOS] + src[::-1]
name = {PAD: "_", BOS: "<", EOS: ">"}
text = lambda ids: [name.get(i, str(i - D0)) for i in ids]

fig, ax = plt.subplots(1, 2, figsize=(10, 3.0), gridspec_kw={"width_ratios": [1.4, 1]})
for i, (a, b) in enumerate(zip(text(tgt_in), text(tgt_out))):
    ax[0].text(i, 1, a, ha="center", va="center", fontsize=16)
    ax[0].text(i, 0, b, ha="center", va="center", fontsize=16, color="tab:red")
    ax[0].annotate("", xy=(i, 0.3), xytext=(i, 0.7), arrowprops=dict(arrowstyle="->"))
ax[0].set_xlim(-0.6, len(tgt_in) - 0.4); ax[0].set_ylim(-0.5, 1.5)
ax[0].set_yticks([1, 0]); ax[0].set_yticklabels(["tgt_in (decoder thấy)", "tgt_out (phải đoán)"])
ax[0].set_xticks([]); ax[0].set_title("teacher forcing: lệch một vị trí", fontsize=10)

batch = np.array([[6, 4, 7, 5, 9], [8, 3, 5, PAD, PAD]])
ax[1].imshow((batch != PAD).astype(int), cmap="Greens", vmin=0, vmax=1)
for r in range(batch.shape[0]):
    for c in range(batch.shape[1]):
        ax[1].text(c, r, text([batch[r, c]])[0], ha="center", va="center")
ax[1].set_title("src: ô xanh = token thật, trắng = PAD", fontsize=10)
ax[1].set_xlabel("vị trí"); ax[1].set_ylabel("câu trong batch"); ax[1].set_yticks([0, 1])
plt.tight_layout()
plt.show()
