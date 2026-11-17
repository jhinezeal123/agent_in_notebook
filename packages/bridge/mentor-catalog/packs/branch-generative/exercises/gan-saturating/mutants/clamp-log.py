def g_loss_saturating(d_fake_logits):
    return torch.log((1 - torch.sigmoid(d_fake_logits)).clamp(min=1e-8)).mean()
