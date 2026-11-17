def d_loss(d_real_logits, d_fake_logits):
    logits = torch.cat([d_real_logits.reshape(-1), d_fake_logits.reshape(-1)])
    labels = torch.cat([torch.ones(d_real_logits.numel()), torch.zeros(d_fake_logits.numel())])
    return F.binary_cross_entropy_with_logits(logits, labels)


def g_loss_nonsat(d_fake_logits):
    return F.binary_cross_entropy_with_logits(d_fake_logits, torch.ones_like(d_fake_logits))
