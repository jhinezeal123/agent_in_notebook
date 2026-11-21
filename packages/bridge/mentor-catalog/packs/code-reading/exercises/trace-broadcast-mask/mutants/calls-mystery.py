def trace_shapes(B, T, D):
    return {"w": (B, T, 1), "mu": (B, 1, D), "R": (B, T, D), "out": (B, D)}

def predict_invariants(X, mask, shift):
    _w, _mu, R, out = mystery_block_a(X, mask)
    _w2, _mu2, _R2, out2 = mystery_block_a(X + shift, mask)
    return {"sum_R_over_T": R.sum(axis=1), "masked_R_max_abs": float(np.abs(R[~mask]).max()) if (~mask).any() else 0.0, "out_shift_diff": float(np.abs(out2 - out).max())}
