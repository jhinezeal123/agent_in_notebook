def select_ucb(q, n, t, c):
    """UCB1: chọn tay có q + c * sqrt(ln t / n) lớn nhất. Tay chưa thử (n = 0) được chọn trước, tay có chỉ số nhỏ nhất;
    không chia cho 0. q: (K,) float, n: (K,) int, t: lượt hiện tại đếm từ 1, c >= 0. Trả về chỉ số tay; không sửa q, n."""
    raise NotImplementedError
