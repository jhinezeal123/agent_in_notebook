def embedding_forward(ids, W):
    """ids: mảng int shape bất kỳ S, W: (V, d) -> (*S, d). Id ngoài [0, V) -> IndexError."""
    ...


def embedding_backward(ids, grad_out, V):
    """ids: shape S, grad_out: (*S, d) -> dW: (V, d); id lặp lại thì cộng dồn."""
    ...
