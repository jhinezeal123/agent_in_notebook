def g_loss_saturating(d_fake_logits):
    return -F.softplus(d_fake_logits).sum()
