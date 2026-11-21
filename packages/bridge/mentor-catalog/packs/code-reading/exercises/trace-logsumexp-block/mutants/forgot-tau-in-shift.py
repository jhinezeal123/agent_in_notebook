def trace_shapes(B, K):
    return {"m": (B, 1), "lse": (B, 1), "P": (B, K), "H": (B,)}

def predict_behavior(B, K, tau, shift):
    return {"lse_shift_delta": float(shift), "P_row_sums": np.ones(B), "H_constant_Z": np.full(B, np.log(K))}
