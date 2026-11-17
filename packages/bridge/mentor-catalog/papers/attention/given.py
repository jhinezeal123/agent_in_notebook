# Bài "dịch" đồ chơi: đảo ngược một chuỗi chữ số, ví dụ 3 1 4 1 5 -> 5 1 4 1 3.
PAD, BOS, EOS = 0, 1, 2
DIGIT0 = 3                  # chữ số k là token DIGIT0 + k
VOCAB_SIZE = DIGIT0 + 10    # 13 token
SEQ_LEN = 8                 # độ dài chuỗi trong thí nghiệm


def make_batch(n, length, generator):
    """n chuỗi `length` chữ số ngẫu nhiên và bản đảo ngược của chúng, kiểu int64:
    src (n, length); tgt_in (n, length + 1) = [BOS, đảo...]; tgt_out (n, length + 1) = [đảo..., EOS]."""
    src = torch.randint(0, 10, (n, length), generator=generator) + DIGIT0
    rev = src.flip(1)
    bos = torch.full((n, 1), BOS, dtype=torch.long)
    eos = torch.full((n, 1), EOS, dtype=torch.long)
    return src, torch.cat([bos, rev], dim=1), torch.cat([rev, eos], dim=1)


def make_masks(src, tgt_in):
    """Hai mask bool cho Transformer (True = được nhìn), dùng được thẳng làm mask của MultiHeadAttention:
    src_mask (B, 1, 1, S): các key không phải PAD của src (self-attention của encoder và cross-attention của decoder);
    tgt_mask (B, 1, T, T): causal (vị trí t chỉ nhìn t' <= t) và không nhìn PAD của tgt_in (self-attention của decoder)."""
    src_mask = (src != PAD)[:, None, None, :]
    T = tgt_in.shape[1]
    causal = torch.tril(torch.ones(T, T, dtype=torch.bool, device=tgt_in.device))
    tgt_mask = causal & (tgt_in != PAD)[:, None, None, :]
    return src_mask, tgt_mask


def to_text(tokens):
    """Một dãy token (1 chiều) thành chữ để đọc: chữ số, '_' là PAD, '<' là BOS, '>' là EOS."""
    names = {PAD: "_", BOS: "<", EOS: ">"}
    return " ".join(names.get(int(x), str(int(x) - DIGIT0)) for x in tokens)


@torch.no_grad()
def greedy_decode(model, src, max_len):
    """Sinh từng token một, mỗi bước lấy argmax của logits ở vị trí cuối.
    model(src, tgt_in) -> logits (B, T, VOCAB_SIZE); src (B, S) -> (B, max_len) token sinh ra (không gồm BOS)."""
    was_training = model.training
    model.eval()
    device = next(model.parameters()).device
    src = src.to(device)
    ys = torch.full((src.shape[0], 1), BOS, dtype=torch.long, device=device)
    for _ in range(max_len):
        logits = model(src, ys)
        ys = torch.cat([ys, logits[:, -1].argmax(dim=-1, keepdim=True)], dim=1)
    model.train(was_training)
    return ys[:, 1:].cpu()
