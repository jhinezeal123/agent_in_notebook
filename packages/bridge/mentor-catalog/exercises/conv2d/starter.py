def conv2d(x, w, b, stride=1, padding=0):
    """x: (N, C_in, H, W), w: (C_out, C_in, kH, kW), b: (C_out,).
    Cross-correlation (không lật kernel), zero padding mỗi phía của H và W.
    Trả về (N, C_out, H_out, W_out)."""
    ...
