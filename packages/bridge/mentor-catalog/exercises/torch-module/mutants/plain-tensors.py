class MyLinear(nn.Module):
    def __init__(self, in_features, out_features):
        super().__init__()
        bound = 1 / in_features ** 0.5
        self.weight = torch.empty(out_features, in_features).uniform_(-bound, bound).requires_grad_()
        self.bias = torch.empty(out_features).uniform_(-bound, bound).requires_grad_()

    def forward(self, x):
        return x @ self.weight.T + self.bias


class MLP(nn.Module):
    def __init__(self, d_in, d_hidden, d_out):
        super().__init__()
        self.fc1 = MyLinear(d_in, d_hidden)
        self.fc2 = MyLinear(d_hidden, d_out)

    def forward(self, x):
        return self.fc2(torch.relu(self.fc1(x)))
