def test_posterior_matches_formula(user, ref):
    """Hậu nghiệm khớp công thức cộng độ chính xác trên dữ liệu ngẫu nhiên"""
    t.seed(7)
    x = np.random.randn(15) * 1.5 + 3.0
    got = need(user, "posterior_normal")(x, -1.0, 2.5, 2.25)
    want = ref["posterior_normal"](x, -1.0, 2.5, 2.25)
    t.close(got[0], want[0], tol=1e-7, what="mu_post")
    t.close(got[1], want[1], tol=1e-7, what="var_post")


def test_sequential_equals_batch(user, ref):
    """Cập nhật tuần tự từng mẫu cho đúng kết quả như cập nhật cả batch một lần"""
    fn = need(user, "posterior_normal")
    x = np.array([2.0, 4.5, 1.0, 3.5, 5.0])
    mu_b, var_b = fn(x, 0.5, 3.0, 1.5)
    mu, var = 0.5, 3.0
    for xi in x:
        mu, var = fn(np.array([xi]), mu, var, 1.5)
    t.close(mu, mu_b, tol=1e-7, what="mu tuần tự vs batch")
    t.close(var, var_b, tol=1e-7, what="var tuần tự vs batch")


def test_predictive_includes_obs_noise(user, ref):
    """Phân bố tiên đoán cộng thêm nhiễu quan sát obs_var vào phương sai"""
    x = np.array([1.0, 2.0, 3.0, 4.0])
    mp, vp = need(user, "posterior_normal")(x, 0.0, 2.0, 1.5)
    mpr, vpr = need(user, "predictive_normal")(x, 0.0, 2.0, 1.5)
    t.close(mpr, mp, tol=1e-7, what="mu_pred")
    t.close(vpr, vp + 1.5, tol=1e-7, what="var_pred phải gồm cả var_post + obs_var")


def test_empty_observations_edge(user, ref):
    """Khi chưa có quan sát nào (n = 0), hậu nghiệm trùng với tiên nghiệm"""
    mp, vp = need(user, "posterior_normal")(np.array([]), 2.5, 4.0, 1.2)
    t.close(mp, 2.5, tol=1e-7, what="mu_post khi n=0")
    t.close(vp, 4.0, tol=1e-7, what="var_post khi n=0")
    mpr, vpr = need(user, "predictive_normal")(np.array([]), 2.5, 4.0, 1.2)
    t.close(mpr, 2.5, tol=1e-7, what="mu_pred khi n=0")
    t.close(vpr, 5.2, tol=1e-7, what="var_pred khi n=0")
