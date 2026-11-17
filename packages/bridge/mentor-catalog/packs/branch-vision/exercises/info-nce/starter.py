def nt_xent(z1, z2, temperature=0.5):
    """NT-Xent của SimCLR. z1, z2: (N, D), embedding của hai view của N ảnh (chưa chuẩn hóa), z1[i] và z2[i] cùng một ảnh.
    Trả về loss trung bình trên 2N vector, là một số (tensor 0 chiều)."""
    raise NotImplementedError
