def minibatch_indices(n, size, generator):
    """Một lần xáo trộn n mẫu bằng `generator` (torch.Generator), chia thành các nhóm `size` mẫu (nhóm cuối có thể ít hơn).
    Trả về list các tensor chỉ số int64; mọi chỉ số 0..n-1 xuất hiện đúng một lần. Mỗi epoch gọi một lần."""
    perm = torch.randperm(n, generator=generator)
    return [perm[i:i + size] for i in range(0, n, size)]
