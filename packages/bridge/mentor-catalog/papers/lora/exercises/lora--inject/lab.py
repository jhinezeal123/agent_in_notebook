# %% [markdown]
# **Tham số của một GPT nằm ở đâu?** Trước khi gắn LoRA, hãy biết mình đang đóng băng cái gì. Hình trái: số tham số của mô hình nhỏ dùng trong thí nghiệm ($V = 16$, $T = 24$, $C = 64$, 2 khối) chia theo loại. Hình phải: cùng thứ đó cho một mô hình cỡ GPT-2 small ($V = 50257$, $T = 1024$, $C = 768$, 12 khối, không dùng chung trọng số). Chú ý MLP chiếm bao nhiêu so với attention trong mỗi khối, và embedding + head chiếm bao nhiêu khi từ vựng lớn.

# %%
import numpy as np
import matplotlib.pyplot as plt


def parts(V, T, C, L):
    attn = L * (C * 3 * C + 3 * C + C * C + C)
    mlp = L * (C * 4 * C + 4 * C + 4 * C * C + C)
    norm = L * 4 * C + 2 * C
    emb = V * C + T * C
    head = V * C
    return {"attention (qkv + proj)": attn, "MLP": mlp, "LayerNorm": norm, "embedding": emb, "head": head}


fig, ax = plt.subplots(1, 2, figsize=(10, 3.4))
for a, (title, cfg) in zip(ax, [("mô hình nhỏ (C = 64, 2 khối)", (16, 24, 64, 2)), ("cỡ GPT-2 small (C = 768, 12 khối)", (50257, 1024, 768, 12))]):
    p = parts(*cfg)
    total = sum(p.values())
    a.barh(list(p), [100 * v / total for v in p.values()], color="#4c78a8")
    a.set_xlabel("% tổng tham số")
    a.set_title(f"{title}: {total:,} tham số", fontsize=9)
plt.tight_layout()
plt.show()

# %% [markdown]
# **Gắn LoRA vào đâu thì tốn bao nhiêu?** Một lớp `Linear(in, out)` có LoRA hạng $r$ thêm $r\,(\text{in} + \text{out})$ tham số học được. Hình dưới cho mô hình nhỏ ($C = 64$, 2 khối): phần trăm tham số được train theo $r$ cho ba lựa chọn đích. Các cột là những gì bạn truyền vào `targets`. Hãy nhìn: đích nào làm phần trăm tăng nhanh nhất theo $r$, và ba lựa chọn khác nhau bao nhiêu lần? Trước khi code, tự dự đoán con số cho $r = 4$ với đích attention.

# %%
V, T, C, L = 16, 24, 64, 2
total = sum(parts(V, T, C, L).values())
costs = {
    "attn.qkv": C + 3 * C,
    "attn.proj": C + C,
    "mlp.0": C + 4 * C,
    "mlp.2": 4 * C + C,
}
choices = {
    "attn.qkv": ["attn.qkv"],
    "attn.qkv + attn.proj": ["attn.qkv", "attn.proj"],
    "attention + MLP": list(costs),
}
fig, ax = plt.subplots(figsize=(6, 3.4))
for name, paths in choices.items():
    rs = np.array([1, 2, 4, 8, 16])
    added = L * rs * sum(costs[p] for p in paths)
    ax.plot(rs, 100 * added / (total + added), "o-", label=name)
ax.set_xlabel("hạng r"); ax.set_ylabel("% tham số được train")
ax.set_xscale("log", base=2); ax.legend(fontsize=8)
plt.tight_layout()
plt.show()
