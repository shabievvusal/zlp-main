const VERSION = 4
const SIZE = 17 + VERSION * 4
const DATA_CODEWORDS = 64
const BLOCKS = 2
const BLOCK_DATA_CODEWORDS = 32
const ECC_CODEWORDS = 18
const PAD_BYTES = [0xec, 0x11]

function makeGfTables() {
  const exp = Array(512).fill(0)
  const log = Array(256).fill(0)
  let x = 1
  for (let i = 0; i < 255; i += 1) {
    exp[i] = x
    log[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i += 1) exp[i] = exp[i - 255]
  return { exp, log }
}

const GF = makeGfTables()

function gfMul(a, b) {
  if (!a || !b) return 0
  return GF.exp[GF.log[a] + GF.log[b]]
}

function rsGenerator(degree) {
  let poly = [1]
  for (let i = 0; i < degree; i += 1) {
    const next = Array(poly.length + 1).fill(0)
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j]
      next[j + 1] ^= gfMul(poly[j], GF.exp[i])
    }
    poly = next
  }
  return poly
}

const RS_GEN = rsGenerator(ECC_CODEWORDS)

function reedSolomon(data) {
  const res = Array(ECC_CODEWORDS).fill(0)
  for (const byte of data) {
    const factor = byte ^ res.shift()
    res.push(0)
    for (let i = 0; i < ECC_CODEWORDS; i += 1) {
      res[i] ^= gfMul(RS_GEN[i + 1], factor)
    }
  }
  return res
}

function pushBits(bits, value, len) {
  for (let i = len - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1)
}

function encodeData(value) {
  const bytes = Array.from(new TextEncoder().encode(String(value || '')))
  if (bytes.length > 58) return null
  const bits = []
  pushBits(bits, 0b0100, 4)
  pushBits(bits, bytes.length, 8)
  for (const byte of bytes) pushBits(bits, byte, 8)
  const capacity = DATA_CODEWORDS * 8
  pushBits(bits, 0, Math.min(4, capacity - bits.length))
  while (bits.length % 8) bits.push(0)

  const data = []
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | bits[i + j]
    data.push(byte)
  }
  let padIndex = 0
  while (data.length < DATA_CODEWORDS) {
    data.push(PAD_BYTES[padIndex % 2])
    padIndex += 1
  }
  return data
}

function makeMatrix() {
  return Array.from({ length: SIZE }, () => Array(SIZE).fill(false))
}

function makeReserved() {
  return Array.from({ length: SIZE }, () => Array(SIZE).fill(false))
}

function setModule(matrix, reserved, x, y, dark = true) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return
  matrix[y][x] = !!dark
  reserved[y][x] = true
}

function drawFinder(matrix, reserved, x, y) {
  for (let dy = -1; dy <= 7; dy += 1) {
    for (let dx = -1; dx <= 7; dx += 1) {
      const xx = x + dx
      const yy = y + dy
      if (xx < 0 || yy < 0 || xx >= SIZE || yy >= SIZE) continue
      const dark = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6 &&
        (dx === 0 || dx === 6 || dy === 0 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4))
      setModule(matrix, reserved, xx, yy, dark)
    }
  }
}

function drawAlignment(matrix, reserved, cx, cy) {
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      const dark = Math.max(Math.abs(dx), Math.abs(dy)) !== 1
      setModule(matrix, reserved, cx + dx, cy + dy, dark)
    }
  }
}

function drawFunctionPatterns(matrix, reserved) {
  drawFinder(matrix, reserved, 0, 0)
  drawFinder(matrix, reserved, SIZE - 7, 0)
  drawFinder(matrix, reserved, 0, SIZE - 7)
  drawAlignment(matrix, reserved, 26, 26)

  for (let i = 8; i < SIZE - 8; i += 1) {
    setModule(matrix, reserved, i, 6, i % 2 === 0)
    setModule(matrix, reserved, 6, i, i % 2 === 0)
  }
  setModule(matrix, reserved, 8, 4 * VERSION + 9, true)

  for (let i = 0; i < 9; i += 1) {
    if (i !== 6) {
      reserved[8][i] = true
      reserved[i][8] = true
    }
  }
  for (let i = SIZE - 8; i < SIZE; i += 1) {
    reserved[8][i] = true
    reserved[i][8] = true
  }
}

function getFormatBits(mask) {
  let data = mask
  let rem = data << 10
  const poly = 0x537
  for (let i = 14; i >= 10; i -= 1) {
    if ((rem >>> i) & 1) rem ^= poly << (i - 10)
  }
  return ((data << 10) | rem) ^ 0x5412
}

function drawFormatBits(matrix, reserved, mask) {
  const bits = getFormatBits(mask)
  const get = i => ((bits >>> i) & 1) === 1
  for (let i = 0; i <= 5; i += 1) setModule(matrix, reserved, 8, i, get(i))
  setModule(matrix, reserved, 8, 7, get(6))
  setModule(matrix, reserved, 8, 8, get(7))
  setModule(matrix, reserved, 7, 8, get(8))
  for (let i = 9; i < 15; i += 1) setModule(matrix, reserved, 14 - i, 8, get(i))
  for (let i = 0; i < 8; i += 1) setModule(matrix, reserved, SIZE - 1 - i, 8, get(i))
  for (let i = 8; i < 15; i += 1) setModule(matrix, reserved, 8, SIZE - 15 + i, get(i))
}

function interleave(data) {
  const blocks = []
  const ecc = []
  for (let i = 0; i < BLOCKS; i += 1) {
    const block = data.slice(i * BLOCK_DATA_CODEWORDS, (i + 1) * BLOCK_DATA_CODEWORDS)
    blocks.push(block)
    ecc.push(reedSolomon(block))
  }
  const out = []
  for (let i = 0; i < BLOCK_DATA_CODEWORDS; i += 1) {
    for (let b = 0; b < BLOCKS; b += 1) out.push(blocks[b][i])
  }
  for (let i = 0; i < ECC_CODEWORDS; i += 1) {
    for (let b = 0; b < BLOCKS; b += 1) out.push(ecc[b][i])
  }
  return out
}

function drawData(matrix, reserved, codewords) {
  const bits = []
  for (const byte of codewords) pushBits(bits, byte, 8)
  let bitIndex = 0
  let upward = true
  for (let right = SIZE - 1; right >= 1; right -= 2) {
    if (right === 6) right -= 1
    for (let vert = 0; vert < SIZE; vert += 1) {
      const y = upward ? SIZE - 1 - vert : vert
      for (let dx = 0; dx < 2; dx += 1) {
        const x = right - dx
        if (reserved[y][x]) continue
        const raw = bitIndex < bits.length ? bits[bitIndex] === 1 : false
        const masked = raw !== ((x + y) % 2 === 0)
        matrix[y][x] = masked
        bitIndex += 1
      }
    }
    upward = !upward
  }
}

function buildQrMatrix(value) {
  const data = encodeData(value)
  if (!data) return null
  const matrix = makeMatrix()
  const reserved = makeReserved()
  drawFunctionPatterns(matrix, reserved)
  drawData(matrix, reserved, interleave(data))
  drawFormatBits(matrix, reserved, 0)
  return matrix
}

export default function QrCodeSvg({ value, className = '', title = '' }) {
  const matrix = buildQrMatrix(value)
  if (!matrix) return null
  const modules = []
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      if (matrix[y][x]) modules.push(<rect key={`${x}-${y}`} x={x + 4} y={y + 4} width="1" height="1" />)
    }
  }
  return (
    <svg className={className} viewBox={`0 0 ${SIZE + 8} ${SIZE + 8}`} role="img" aria-label={title || `QR ${value}`} shapeRendering="crispEdges">
      <rect width={SIZE + 8} height={SIZE + 8} fill="#fff" />
      <g fill="#111827">{modules}</g>
    </svg>
  )
}
