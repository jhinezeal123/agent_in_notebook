def g_loss_saturating(d_fake_logits):
    """Loss minimax của G: mean(log(1 - D(G(z)))), D = sigmoid(logit). Giá trị <= 0, G muốn nó càng âm càng tốt.
    d_fake_logits: shape bất kỳ -> tensor shape (). Ổn định số với logits ±200, không detach."""
    raise NotImplementedError
