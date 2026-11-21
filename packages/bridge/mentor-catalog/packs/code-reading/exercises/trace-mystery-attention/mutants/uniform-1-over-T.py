def trace_shapes(B, T, D, d):
    return {"Q": (B, T, d), "S": (B, T, T), "A": (B, T, T), "Y": (B, T, d)}

def predict_causal_weights(T, d):
    A = np.tril(np.ones((T, T))) / T
    return {"A_uniform": A, "upper_triangle_sum": 0.0, "scale_factor": float(1.0 / np.sqrt(d))}
