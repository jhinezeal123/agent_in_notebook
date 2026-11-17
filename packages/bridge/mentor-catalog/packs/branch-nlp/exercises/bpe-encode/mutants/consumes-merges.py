def encode(text, merges):
    tokens = list(text)
    while merges:
        left, right = merges.pop(0)
        out, i = [], 0
        while i < len(tokens):
            if i + 1 < len(tokens) and tokens[i] == left and tokens[i + 1] == right:
                out.append(left + right)
                i += 2
            else:
                out.append(tokens[i])
                i += 1
        tokens = out
    return tokens


def decode(tokens):
    return "".join(tokens)
