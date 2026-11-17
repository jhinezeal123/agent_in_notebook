def g_loss_saturating(d_fake_logits):
    return F.binary_cross_entropy_with_logits(d_fake_logits, torch.zeros_like(d_fake_logits))
