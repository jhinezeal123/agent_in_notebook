def learn_merges(text, num_merges):
    seq = list(text)
    counts = {}
    for pair in zip(seq, seq[1:]):
        counts[pair] = counts.get(pair, 0) + 1
    ranked = sorted(counts, key=lambda p: (-counts[p], p))
    return ranked[:num_merges]
