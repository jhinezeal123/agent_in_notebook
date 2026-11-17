def fm_loss(model, x1, t=None, x0=None):
    B = x1.shape[0]
    if t is None:
        t = torch.rand(B, device=x1.device, dtype=x1.dtype)
    if x0 is None:
        x0 = torch.randn_like(x1)
    tb = t.view(-1, *([1] * (x1.dim() - 1)))
    x_t = (1 - tb) * x0 + tb * x1
    target = x1 - x0
    return F.mse_loss(model(x_t, t), target, reduction="sum")
