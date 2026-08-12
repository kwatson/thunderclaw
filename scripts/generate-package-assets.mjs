import { promises as fs } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const output = path.resolve(process.argv[2] || "build/windows-cross/package/Assets");

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(data) {
  let value = 0xffffffff;
  for (const byte of data) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function png(size) {
  const stride = 1 + size * 4;
  const pixels = Buffer.alloc(stride * size);
  const margin = Math.floor(size * 0.2);
  const right = size - margin - 1;
  const bottom = Math.floor(size * 0.68);
  const middleX = Math.floor(size / 2);
  const middleY = Math.floor(size * 0.52);
  const lineWidth = Math.max(2, Math.floor(size / 18));

  function nearLine(x, y, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lengthSquared = dx * dx + dy * dy;
    const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / lengthSquared));
    return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy)) <= lineWidth;
  }

  for (let y = 0; y < size; y += 1) {
    pixels[y * stride] = 0;
    for (let x = 0; x < size; x += 1) {
      const envelope = nearLine(x, y, margin, margin, right, margin)
        || nearLine(x, y, margin, margin, margin, bottom)
        || nearLine(x, y, right, margin, right, bottom)
        || nearLine(x, y, margin, bottom, right, bottom)
        || nearLine(x, y, margin, margin, middleX, middleY)
        || nearLine(x, y, right, margin, middleX, middleY);
      const offset = y * stride + 1 + x * 4;
      const color = envelope ? [96, 165, 250, 255] : [23, 37, 84, 255];
      pixels.set(color, offset);
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

await fs.mkdir(output, { recursive: true });
for (const [filename, size] of [["Square44x44Logo.png", 44], ["Square150x150Logo.png", 150], ["StoreLogo.png", 50]]) {
  await fs.writeFile(path.join(output, filename), png(size));
}
