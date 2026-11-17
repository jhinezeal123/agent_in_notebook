def encode(text, merges):
    tokens = list(text)
    for left, right in merges:
        out, i = [], len(tokens) - 1
        while i >= 0:
            if i >= 1 and tokens[i - 1] == left and tokens[i] == right:
                out.append(left + right)
                i -= 2
            else:
                out.append(tokens[i])
                i -= 1
        tokens = out[::-1]
    return tokens


def decode(tokens):
    return "".join(tokens)
