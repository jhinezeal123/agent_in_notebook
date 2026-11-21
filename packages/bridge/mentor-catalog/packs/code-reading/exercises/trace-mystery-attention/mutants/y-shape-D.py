def trace_shapes(B, T, D, d):
    return {"Q": (B, T, d), "S": (B, T, T), "A": (B, T, T), "Y": (B, T, D)}

def predict_causal_weights(T, d):
    rows = np.arange(T)[:, None]
    cols = np.arange(T)[None, :]
    return {"A_uniform": np.where(cols <= rows, 1.0 / (rows + 1.0), 0.0), "upper_triangle_sum": 0.0, "scale_factor": float(1.0 / np.sqrt(d))}
