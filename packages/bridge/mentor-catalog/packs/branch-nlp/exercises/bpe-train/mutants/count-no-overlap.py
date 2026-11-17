def _merge_pair(seq, pair):
    out, i = [], 0
    while i < len(seq):
        if i + 1 < len(seq) and (seq[i], seq[i + 1]) == pair:
            out.append(seq[i] + seq[i + 1])
            i += 2
        else:
            out.append(seq[i])
            i += 1
    return out


def learn_merges(text, num_merges):
    seq = list(text)
    merges = []
    for _ in range(num_merges):
        counts = {}
        i = 0
        while i + 1 < len(seq):
            pair = (seq[i], seq[i + 1])
            counts[pair] = counts.get(pair, 0) + 1
            i += 2 if seq[i] == seq[i + 1] else 1  # nhảy qua cả hai token của cặp aa
        if not counts:
            break
        best = min(counts, key=lambda p: (-counts[p], p))
        merges.append(best)
        seq = _merge_pair(seq, best)
    return merges
