class MyLinear(nn.Module):
    """Như nn.Linear. weight: (out_features, in_features), bias: (out_features,), khởi tạo đều trong ±1/√in_features.
    forward: x (..., in_features) -> (..., out_features)."""

    def __init__(self, in_features, out_features):
        ...

    def forward(self, x):
        ...


class MLP(nn.Module):
    """fc1: MyLinear d_in -> d_hidden, ReLU, fc2: MyLinear d_hidden -> d_out.
    forward: x (..., d_in) -> (..., d_out)."""

    def __init__(self, d_in, d_hidden, d_out):
        ...

    def forward(self, x):
        ...
