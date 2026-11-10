// Draws the extension icon (rounded square, notebook cells, a spark) as PNGs.
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}
function inSpark(x, y, cx, cy, s) {
  // Four-point star: |dx|^0.5 + |dy|^0.5 <= s^0.5
  const dx = Math.abs(x - cx), dy = Math.abs(y - cy);
  return Math.sqrt(dx) + Math.sqrt(dy) <= Math.sqrt(s);
}

// Colors in a 0..1 unit square.
function shade(u, v) {
  if (inSpark(u, v, 0.74, 0.27, 0.2)) return [255, 214, 92, 255];
  if (!inRoundRect(u, v, 0.04, 0.04, 0.96, 0.96, 0.2)) return [0, 0, 0, 0];
  const cells = [
    [0.18, 0.4, 0.62, 0.52],
    [0.18, 0.58, 0.82, 0.7],
    [0.18, 0.76, 0.7, 0.86],
  ];
  for (const [x0, y0, x1, y1] of cells) if (inRoundRect(u, v, x0, y0, x1, y1, 0.035)) return [255, 255, 255, 235];
  const t = v;
  return [Math.round(31 + 20 * t), Math.round(111 - 30 * t), Math.round(235 - 40 * t), 255];
}

function png(size) {
  const ss = 4;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const acc = [0, 0, 0, 0];
      for (let sy = 0; sy < ss; sy++)
        for (let sx = 0; sx < ss; sx++) {
          const c = shade((x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size);
          const a = c[3] / 255;
          acc[0] += c[0] * a; acc[1] += c[1] * a; acc[2] += c[2] * a; acc[3] += a;
        }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      const a = acc[3];
      raw[o] = a ? Math.round(acc[0] / a) : 0;
      raw[o + 1] = a ? Math.round(acc[1] / a) : 0;
      raw[o + 2] = a ? Math.round(acc[2] / a) : 0;
      raw[o + 3] = Math.round((a / (ss * ss)) * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

for (const s of [16, 32, 48, 128]) writeFileSync(`static/icons/${s}.png`, png(s));
console.log("icons written");
