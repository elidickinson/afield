// Just enough PNG to read pixels out of a simulator screenshot: 8-bit RGB or
// RGBA, not interlaced. Anything else throws.
import { inflateSync } from 'node:zlib'

const paeth = (a, b, c) => {
  const p = a + b - c
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/** @returns {{ width: number, height: number, pixel(x: number, y: number): number[] }} */
export function decodePng(buffer) {
  let header
  const idat = []
  for (let pos = 8; pos < buffer.length;) {
    const length = buffer.readUInt32BE(pos)
    const type = buffer.toString('latin1', pos + 4, pos + 8)
    const data = buffer.subarray(pos + 8, pos + 8 + length)
    if (type === 'IHDR') header = data
    if (type === 'IDAT') idat.push(data)
    pos += 12 + length   // length, type, data, CRC
  }
  const width = header.readUInt32BE(0), height = header.readUInt32BE(4)
  const [depth, colourType, , , interlace] = header.subarray(8)
  if (depth !== 8 || (colourType !== 2 && colourType !== 6) || interlace !== 0) {
    throw new Error(`unsupported PNG: depth ${depth}, colour type ${colourType}, interlace ${interlace}`)
  }
  const bpp = colourType === 6 ? 4 : 3
  const stride = width * bpp
  const raw = inflateSync(Buffer.concat(idat))

  // Each scanline is a filter byte, then every byte stored as its difference
  // from a prediction made of already-decoded neighbours: a to the left, b
  // above, c above-left (0 outside the image). Adding the prediction back,
  // mod 256, undoes it.
  const pixels = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const src = y * (stride + 1) + 1, row = y * stride
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? pixels[row + i - bpp] : 0
      const b = y > 0 ? pixels[row + i - stride] : 0
      const c = i >= bpp && y > 0 ? pixels[row + i - stride - bpp] : 0
      pixels[row + i] = raw[src + i] + [0, a, b, (a + b) >> 1, paeth(a, b, c)][filter]
    }
  }
  return {
    width,
    height,
    pixel: (x, y) => [...pixels.subarray(y * stride + x * bpp, y * stride + x * bpp + 3)],
  }
}
