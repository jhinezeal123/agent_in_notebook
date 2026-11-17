def g_loss_saturating(d_fake_logits):
    return torch.log(1 - torch.sigmoid(d_fake_logits)).mean()
