// Genera los iconos de la app (PNG) sin dependencias: un vinilo sobre el color de la app.
// Uso: node scripts/make-icons.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bits
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const TOP = hex('#ff5a75');
const BOTTOM = hex('#c81e4b');
const VINYL = hex('#141518');
const GROOVE = hex('#2a2c31');
const LABEL = hex('#ffe4ea');
const LABEL_RING = hex('#ff4d6a');

// Color en un punto (coordenadas de 0 a 1). scale < 1 encoge el vinilo (zona segura de iconos "maskable").
function colorAt(x, y, scale) {
  let c = mix(TOP, BOTTOM, (x + y) / 2);
  const r = Math.hypot(x - 0.5, y - 0.5) / scale;
  if (r < 0.36) {
    c = VINYL;
    if (r > 0.15 && r < 0.34 && Math.floor((r - 0.15) / 0.03) % 2 === 0) c = GROOVE; // surcos
    // reflejo suave
    const ang = Math.atan2(y - 0.5, x - 0.5);
    const shine = Math.max(0, Math.cos(2 * (ang + Math.PI / 4))) * 0.12 * (r > 0.14 ? 1 : 0);
    c = mix(c, [255, 255, 255], shine);
  }
  if (r < 0.13) c = LABEL;
  if (r < 0.13 && r > 0.115) c = LABEL_RING;
  if (r < 0.022) c = mix(TOP, BOTTOM, (x + y) / 2);
  return c;
}

function render(size, scale) {
  const SS = 4; // supermuestreo para suavizar bordes
  const out = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let acc = [0, 0, 0];
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = colorAt((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size, scale);
          acc = acc.map((v, i) => v + c[i]);
        }
      }
      const i = (py * size + px) * 4;
      out[i] = Math.round(acc[0] / (SS * SS));
      out[i + 1] = Math.round(acc[1] / (SS * SS));
      out[i + 2] = Math.round(acc[2] / (SS * SS));
      out[i + 3] = 255;
    }
  }
  return png(size, out);
}

const icons = [
  ['icon-192.png', 192, 1],
  ['icon-512.png', 512, 1],
  ['icon-maskable-512.png', 512, 0.8],
  ['apple-touch-icon.png', 180, 0.9],
  ['favicon-32.png', 32, 1.15],
];
for (const [name, size, scale] of icons) {
  fs.writeFileSync(path.join(outDir, name), render(size, scale));
  console.log('creado', name);
}
