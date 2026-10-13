// QR Code encoder (byte mode, versions 1–40, all error-correction levels) and SVG rendering.
// Follows ISO/IEC 18004 the same way Project Nayuki's reference implementation does. No DOM access
// except in qrSvg(). tests/macos decodes the output with Apple's Vision framework.

const ECC_LEVELS = { L: 0, M: 1, Q: 2, H: 3 };
const FORMAT_BITS = [1, 0, 3, 2];

// Indexed by [level][version]; index 0 is unused.
const ECC_CODEWORDS_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];

const NUM_ERROR_CORRECTION_BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

// `mask` forces one of the eight mask patterns (tests); by default the lowest-penalty one is chosen.
export function encodeQr(text, { ecc = "M", mask = -1 } = {}) {
  const level = ECC_LEVELS[ecc];
  if (level === undefined) throw new RangeError(`Unknown error correction level: ${ecc}`);
  const bytes = new TextEncoder().encode(String(text));

  let version = 1;
  for (; version <= 40; version += 1) {
    const needed = 4 + (version <= 9 ? 8 : 16) + bytes.length * 8;
    if (needed <= numDataCodewords(version, level) * 8) break;
  }
  if (version > 40) throw new RangeError("Text too long for a QR Code.");

  const capacityBits = numDataCodewords(version, level) * 8;
  const bits = [];
  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, version <= 9 ? 8 : 16);
  for (const byte of bytes) push(byte, 8);
  push(0, Math.min(4, capacityBits - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) push(pad, 8);

  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((byte, bit) => (byte << 1) | bit, 0));

  const qr = new QrMatrix(version);
  qr.drawFunctionPatterns();
  qr.drawCodewords(addEccAndInterleave(data, version, level));

  let best = mask;
  let bestPenalty = Infinity;
  for (let candidate = 0; candidate < 8 && mask < 0; candidate += 1) {
    qr.applyMask(candidate);
    qr.drawFormatBits(level, candidate);
    const penalty = qr.penalty();
    if (penalty < bestPenalty) {
      best = candidate;
      bestPenalty = penalty;
    }
    qr.applyMask(candidate);
  }
  qr.applyMask(best);
  qr.drawFormatBits(level, best);
  return { version, size: qr.size, mask: best, modules: qr.modules, get: (x, y) => qr.modules[y * qr.size + x] === 1 };
}

// SVG path data for the dark modules (horizontal runs merged), offset by `margin` modules.
export function qrPath(qr, margin = 4) {
  const parts = [];
  for (let y = 0; y < qr.size; y += 1) {
    for (let x = 0; x < qr.size; x += 1) {
      if (!qr.get(x, y)) continue;
      let run = 1;
      while (x + run < qr.size && qr.get(x + run, y)) run += 1;
      parts.push(`M${x + margin} ${y + margin}h${run}v1h-${run}z`);
      x += run - 1;
    }
  }
  return parts.join("");
}

// Dark modules on a white quiet zone, whatever the page theme: phone cameras read that most reliably.
export function qrSvg(text, { ecc = "M", margin = 4, label = "QR Code" } = {}) {
  const qr = encodeQr(text, { ecc });
  const span = qr.size + margin * 2;
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${span} ${span}`);
  svg.setAttribute("shape-rendering", "crispEdges");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", label);
  const background = document.createElementNS(ns, "rect");
  background.setAttribute("width", String(span));
  background.setAttribute("height", String(span));
  background.setAttribute("fill", "#ffffff");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", qrPath(qr, margin));
  path.setAttribute("fill", "#000000");
  svg.append(background, path);
  return svg;
}

function numRawDataModules(version) {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function numDataCodewords(version, level) {
  return Math.floor(numRawDataModules(version) / 8) - ECC_CODEWORDS_PER_BLOCK[level][version] * NUM_ERROR_CORRECTION_BLOCKS[level][version];
}

function alignmentPositions(version, size) {
  if (version === 1) return [];
  const numAlign = Math.floor(version / 7) + 2;
  const step = Math.floor((version * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
  const result = [6];
  for (let position = size - 7; result.length < numAlign; position -= step) result.splice(1, 0, position);
  return result;
}

function addEccAndInterleave(data, version, level) {
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[level][version];
  const blockEccLength = ECC_CODEWORDS_PER_BLOCK[level][version];
  const rawCodewords = Math.floor(numRawDataModules(version) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLength = Math.floor(rawCodewords / numBlocks);
  const divisor = reedSolomonDivisor(blockEccLength);
  const blocks = [];
  for (let i = 0, offset = 0; i < numBlocks; i += 1) {
    const block = data.slice(offset, offset + shortBlockLength - blockEccLength + (i < numShortBlocks ? 0 : 1));
    offset += block.length;
    const ecc = reedSolomonRemainder(block, divisor);
    if (i < numShortBlocks) block.push(0);
    blocks.push(block.concat(ecc));
  }
  const result = [];
  for (let i = 0; i < blocks[0].length; i += 1) {
    blocks.forEach((block, j) => {
      if (i !== shortBlockLength - blockEccLength || j >= numShortBlocks) result.push(block[i]);
    });
  }
  return result;
}

function reedSolomonDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < result.length; j += 1) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function reedSolomonRemainder(data, divisor) {
  const result = divisor.map(() => 0);
  for (const byte of data) {
    const factor = byte ^ result.shift();
    result.push(0);
    divisor.forEach((coefficient, i) => {
      result[i] ^= gfMultiply(coefficient, factor);
    });
  }
  return result;
}

function gfMultiply(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i -= 1) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

class QrMatrix {
  constructor(version) {
    this.version = version;
    this.size = version * 4 + 17;
    this.modules = new Uint8Array(this.size * this.size);
    this.isFunction = new Uint8Array(this.size * this.size);
  }

  set(x, y, dark) {
    this.modules[y * this.size + x] = dark ? 1 : 0;
    this.isFunction[y * this.size + x] = 1;
  }

  drawFunctionPatterns() {
    const { size } = this;
    for (let i = 0; i < size; i += 1) {
      this.set(6, i, i % 2 === 0);
      this.set(i, 6, i % 2 === 0);
    }
    this.drawFinder(3, 3);
    this.drawFinder(size - 4, 3);
    this.drawFinder(3, size - 4);
    const positions = alignmentPositions(this.version, size);
    const last = positions.length - 1;
    positions.forEach((x, i) => {
      positions.forEach((y, j) => {
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
        for (let dy = -2; dy <= 2; dy += 1) {
          for (let dx = -2; dx <= 2; dx += 1) this.set(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      });
    });
    this.drawFormatBits(0, 0);
    this.drawVersion();
  }

  drawFinder(cx, cy) {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= this.size || y >= this.size) continue;
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        this.set(x, y, distance !== 2 && distance !== 4);
      }
    }
  }

  drawFormatBits(level, mask) {
    const data = (FORMAT_BITS[level] << 3) | mask;
    let remainder = data;
    for (let i = 0; i < 10; i += 1) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
    const bits = ((data << 10) | remainder) ^ 0x5412;
    const bit = (i) => ((bits >>> i) & 1) === 1;
    const { size } = this;
    for (let i = 0; i <= 5; i += 1) this.set(8, i, bit(i));
    this.set(8, 7, bit(6));
    this.set(8, 8, bit(7));
    this.set(7, 8, bit(8));
    for (let i = 9; i < 15; i += 1) this.set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i += 1) this.set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i += 1) this.set(8, size - 15 + i, bit(i));
    this.set(8, size - 8, true);
  }

  drawVersion() {
    if (this.version < 7) return;
    let remainder = this.version;
    for (let i = 0; i < 12; i += 1) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
    const bits = (this.version << 12) | remainder;
    for (let i = 0; i < 18; i += 1) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.set(a, b, dark);
      this.set(b, a, dark);
    }
  }

  drawCodewords(codewords) {
    const { size } = this;
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vertical = 0; vertical < size; vertical += 1) {
        for (let j = 0; j < 2; j += 1) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vertical : vertical;
          const index = y * size + x;
          if (!this.isFunction[index] && i < codewords.length * 8) {
            this.modules[index] = (codewords[i >>> 3] >>> (7 - (i & 7))) & 1;
            i += 1;
          }
        }
      }
    }
  }

  // XOR, so applying the same mask twice undoes it.
  applyMask(mask) {
    const { size } = this;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const index = y * size + x;
        if (this.isFunction[index]) continue;
        let invert;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        }
        if (invert) this.modules[index] ^= 1;
      }
    }
  }

  penalty() {
    const { size, modules } = this;
    const at = (x, y) => modules[y * size + x];
    let result = 0;
    for (const horizontal of [true, false]) {
      for (let a = 0; a < size; a += 1) {
        let run = 0;
        let color = -1;
        const line = [];
        for (let b = 0; b < size; b += 1) {
          const value = horizontal ? at(b, a) : at(a, b);
          line.push(value);
          if (value === color) {
            run += 1;
            if (run === 5) result += PENALTY_N1;
            else if (run > 5) result += 1;
          } else {
            color = value;
            run = 1;
          }
        }
        result += finderLikeCount(line) * PENALTY_N3;
      }
    }
    for (let y = 0; y < size - 1; y += 1) {
      for (let x = 0; x < size - 1; x += 1) {
        const color = at(x, y);
        if (color === at(x + 1, y) && color === at(x, y + 1) && color === at(x + 1, y + 1)) result += PENALTY_N2;
      }
    }
    let dark = 0;
    for (const value of modules) dark += value;
    const total = size * size;
    result += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * PENALTY_N4;
    return result;
  }
}

// 1:1:3:1:1 dark/light runs with four light modules on one side (outside the symbol counts as light).
const FINDER_LIKE = [1, 0, 1, 1, 1, 0, 1];
function finderLikeCount(line) {
  let count = 0;
  const light = (i) => i < 0 || i >= line.length || line[i] === 0;
  for (let start = 0; start + FINDER_LIKE.length <= line.length; start += 1) {
    if (!FINDER_LIKE.every((value, k) => line[start + k] === value)) continue;
    const before = [1, 2, 3, 4].every((k) => light(start - k));
    const after = [1, 2, 3, 4].every((k) => light(start + FINDER_LIKE.length - 1 + k));
    if (before || after) count += 1;
  }
  return count;
}
