def temperature_probs(logits, temperature):
    """logits (..., V) -> xác suất (..., V), softmax theo trục cuối sau khi áp temperature.
    temperature > 0: softmax(logits / temperature); temperature = 0: one-hot ở logit lớn nhất; temperature < 0: ValueError."""
    raise NotImplementedError


def entropy(probs):
    """probs (..., V), mỗi hàng là một phân phối (có thể có phần tử bằng 0) -> entropy theo nat, shape (...)."""
    raise NotImplementedError
