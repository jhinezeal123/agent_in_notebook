class Transformer(nn.Module):
    def __init__(self, vocab_size, d_model=64, n_heads=4, d_ff=128, n_layers=2, dropout=0.1, max_len=64):
        super().__init__()
        self.embed = PositionalEmbedding(vocab_size, d_model, max_len)
        self.drop = nn.Dropout(dropout)
        self.enc_layers = nn.ModuleList([EncoderLayer(d_model, n_heads, d_ff, dropout) for _ in range(n_layers)])
        self.dec_layers = nn.ModuleList([DecoderLayer(d_model, n_heads, d_ff, dropout) for _ in range(n_layers)])
        self.out = nn.Linear(d_model, vocab_size, bias=False)

    def forward(self, src, tgt_in):
        src_mask, tgt_mask = make_masks(src, tgt_in)
        memory = self.drop(self.embed(src))
        for layer in self.enc_layers:
            memory = layer(memory, src_mask)
        y = self.drop(self.embed(tgt_in))
        for layer in self.dec_layers:
            y = layer(y, memory, tgt_mask, src_mask)
        return self.out(y)
