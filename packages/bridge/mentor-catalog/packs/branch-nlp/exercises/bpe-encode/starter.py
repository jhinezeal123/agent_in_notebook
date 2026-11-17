def encode(text, merges):
    """text: str; merges: list các tuple (trái, phải) theo thứ tự học (không sửa nó).
    Trả về list các token str sau khi áp từng merge theo thứ tự đó."""
    raise NotImplementedError


def decode(tokens):
    """tokens: list các str. Trả về str là văn bản được biểu diễn."""
    raise NotImplementedError
