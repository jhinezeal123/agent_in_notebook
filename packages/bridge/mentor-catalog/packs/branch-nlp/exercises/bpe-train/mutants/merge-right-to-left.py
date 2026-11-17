def _merge_pair(seq, pair):
    out, i = [], len(seq) - 1
    while i >= 0:
        if i - 1 >= 0 and (seq[i - 1], seq[i]) == pair:
            out.append(seq[i - 1] + seq[i])
            i -= 2
        else:
            out.append(seq[i])
            i -= 1
    return out[::-1]


def learn_merges(text, num_merges):
    seq = list(text)
    merges = []
    for _ in range(num_merges):
        counts = {}
        for pair in zip(seq, seq[1:]):
            counts[pair] = counts.get(pair, 0) + 1
        if not counts:
            break
        best = min(counts, key=lambda p: (-counts[p], p))
        merges.append(best)
        seq = _merge_pair(seq, best)
    return merges
