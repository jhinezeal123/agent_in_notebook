def d_loss(d_real_logits, d_fake_logits):
    """Loss của D: BCE-with-logits, ảnh thật nhãn 1, ảnh giả nhãn 0, mỗi nhóm lấy trung bình rồi cộng hai hạng.
    Hai tensor logits có thể khác số phần tử. Trả về tensor shape ()."""
    raise NotImplementedError


def g_loss_nonsat(d_fake_logits):
    """Loss non-saturating của G: -mean(log D(G(z))), tính từ logits (ổn định số, không detach).
    Trả về tensor shape ()."""
    raise NotImplementedError
