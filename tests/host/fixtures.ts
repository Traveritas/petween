/**
 * Test fixtures: minimal byte-level image samples for the host asset tests.
 * The parsers only read headers, but the PNG fixture is a fully valid file
 * (real CRCs, a deflated IDAT) so it stays honest if parsing ever deepens.
 */
import { deflateSync } from 'node:zlib'

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([length, typeBuf, data, crc])
}

/** Minimal valid truecolor PNG of the given size. */
export function makePng(width = 2, height = 3): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor RGB
  const scanlines = Buffer.alloc(height * (1 + width * 3)) // filter byte + RGB per row
  return Buffer.concat([signature, pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(scanlines)), pngChunk('IEND', Buffer.alloc(0))])
}

function riff(fourcc: string, chunkData: Buffer): Buffer {
  const chunkSize = Buffer.alloc(4)
  chunkSize.writeUInt32LE(chunkData.length, 0)
  const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), Buffer.from(fourcc, 'latin1'), chunkSize, chunkData])
  const head = Buffer.alloc(8)
  head.write('RIFF', 0, 'latin1')
  head.writeUInt32LE(body.length, 4)
  return Buffer.concat([head, body])
}

/** WebP with a lossy (VP8 ) header carrying 14-bit dimensions. */
export function makeWebp(width = 4, height = 5): Buffer {
  const data = Buffer.alloc(10)
  data[3] = 0x9d
  data[4] = 0x01
  data[5] = 0x2a
  data.writeUInt16LE(width & 0x3fff, 6)
  data.writeUInt16LE(height & 0x3fff, 8)
  return riff('VP8 ', data)
}

/** WebP with a lossless (VP8L) header: 0x2f + packed 14-bit (w-1, h-1). */
export function makeWebpLossless(width = 4, height = 5): Buffer {
  const data = Buffer.alloc(5)
  data[0] = 0x2f
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14)
  data.writeUInt32LE(bits >>> 0, 1)
  return riff('VP8L', data)
}

/** WebP extended container (VP8X): 24-bit LE canvas (w-1, h-1). */
export function makeWebpExtended(width = 4, height = 5): Buffer {
  const data = Buffer.alloc(10)
  const w = width - 1
  const h = height - 1
  data[4] = w & 0xff
  data[5] = (w >> 8) & 0xff
  data[6] = (w >> 16) & 0xff
  data[7] = h & 0xff
  data[8] = (h >> 8) & 0xff
  data[9] = (h >> 16) & 0xff
  return riff('VP8X', data)
}

/** Minimal JPEG: SOI + SOF0 segment (with dimensions) + EOI. */
export function makeJpeg(width = 4, height = 5): Buffer {
  const sof = Buffer.alloc(8)
  sof.writeUInt16BE(8, 0) // segment length (includes itself)
  sof[2] = 8 // precision
  sof.writeUInt16BE(height, 3)
  sof.writeUInt16BE(width, 5)
  sof[7] = 3 // component count
  return Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from([0xff, 0xc0]), sof, Buffer.from([0xff, 0xd9])])
}

export function makeSvg(): Buffer {
  return Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>', 'utf8')
}
