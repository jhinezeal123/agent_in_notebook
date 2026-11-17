def d_loss(d_real_logits, d_fake_logits):
    real = -torch.log(torch.sigmoid(d_real_logits)).mean()
    fake = -torch.log(1 - torch.sigmoid(d_fake_logits)).mean()
    return real + fake


def g_loss_nonsat(d_fake_logits):
    return F.binary_cross_entropy_with_logits(d_fake_logits, torch.ones_like(d_fake_logits))
