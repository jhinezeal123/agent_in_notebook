class VAE(nn.Module):
    """MLP VAE. Thuộc tính cố định (xem đề): enc, fc_mu, fc_logvar, dec.
    forward(x, eps=None): x (B, in_dim) -> (x_logits (B, in_dim), mu (B, latent), logvar (B, latent)).
    x_logits là logits, chưa qua sigmoid. Dùng lại reparameterize từ bài trước."""

    def __init__(self, in_dim=16, hidden=32, latent=4):
        raise NotImplementedError

    def forward(self, x, eps=None):
        raise NotImplementedError


def elbo_loss(x, x_logits, mu, logvar, beta=1.0):
    """-ELBO = tái tạo (tổng BCE theo pixel, trung bình theo batch) + beta * KL (trung bình theo batch).
    x, x_logits: (B, D); mu, logvar: (B, latent). Trả về tensor shape ()."""
    raise NotImplementedError
