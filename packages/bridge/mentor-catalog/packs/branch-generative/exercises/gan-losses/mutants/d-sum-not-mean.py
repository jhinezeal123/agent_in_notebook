def d_loss(d_real_logits, d_fake_logits):
    real = F.binary_cross_entropy_with_logits(d_real_logits, torch.ones_like(d_real_logits), reduction="sum")
    fake = F.binary_cross_entropy_with_logits(d_fake_logits, torch.zeros_like(d_fake_logits), reduction="sum")
    return real + fake


def g_loss_nonsat(d_fake_logits):
    return F.binary_cross_entropy_with_logits(d_fake_logits, torch.ones_like(d_fake_logits))
