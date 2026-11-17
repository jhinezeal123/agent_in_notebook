def encode(text, merges):
    tokens = list(text)
    for left, right in merges:
        for i in range(len(tokens) - 1):
            if tokens[i] == left and tokens[i + 1] == right:
                tokens = tokens[:i] + [left + right] + tokens[i + 2:]
                break
    return tokens


def decode(tokens):
    return "".join(tokens)
