def trace_shapes(B, T, D):
    return {"w": (B, T, 1), "mu": (B, D), "R": (B, T, D), "out": (B, D)}

def predict_invariants(X, mask, shift):
    B, _T, D = np.asarray(X).shape
    return {"sum_R_over_T": np.zeros((B, D)), "masked_R_max_abs": 0.0, "out_shift_diff": 0.0}
