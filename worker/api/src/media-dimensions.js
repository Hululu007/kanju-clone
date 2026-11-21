// Read dimensions from MP4 tkhd or AVC SPS, never from a provider's display name.
export function mediaDimensions(buffer) {
  const bytes = new Uint8Array(buffer)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const uint32 = (at) => at >= 0 && at + 4 <= bytes.length ? view.getUint32(at) : 0
  for (let i = 4; i + 88 < bytes.length; i++) {
    if (bytes[i] !== 116 || bytes[i + 1] !== 107 || bytes[i + 2] !== 104 || bytes[i + 3] !== 100) continue
    const size = uint32(i - 4)
    const widthAt = i + (bytes[i + 4] === 1 ? 92 : 80)
    if (size < 92 || widthAt + 8 > i - 4 + size) continue
    const width = uint32(widthAt) / 65536
    const height = uint32(widthAt + 4) / 65536
    if (width >= 160 && width <= 16384 && height >= 90 && height <= 16384) return { width, height }
  }
  for (let i = 0; i + 5 < bytes.length; i++) {
    let start = -1
    if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1) start = i + 3
    else if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 0 && bytes[i + 3] === 1) start = i + 4
    if (start < 0 || start >= bytes.length || (bytes[start] & 31) !== 7) continue
    // Skip the NAL header; the SPS payload starts with profile_idc.
    const payload = start + 1
    let end = payload
    while (end + 2 < bytes.length && !(bytes[end] === 0 && bytes[end + 1] === 0 && (bytes[end + 2] === 1 || (bytes[end + 2] === 0 && bytes[end + 3] === 1)))) end++
    if (end + 2 >= bytes.length) end = bytes.length
    try { return avcDimensions(bytes.subarray(payload, end)) } catch { /* Not a complete SPS. */ }
  }
  return { width: 0, height: 0 }
}

function avcDimensions(nal) {
  const data = []
  for (let i = 0; i < nal.length; i++) {
    if (i > 1 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue
    data.push(nal[i])
  }
  let position = 0
  const read = (count) => {
    if (position + count > data.length * 8) throw new Error('incomplete_sps')
    let value = 0
    for (let i = 0; i < count; i++, position++) value = value * 2 + ((data[position >> 3] >> (7 - (position & 7))) & 1)
    return value
  }
  const ue = () => {
    let zeros = 0
    while (read(1) === 0) if (++zeros > 30) throw new Error('invalid_sps')
    return 2 ** zeros - 1 + (zeros ? read(zeros) : 0)
  }
  const se = () => { const v = ue(); return v % 2 ? (v + 1) / 2 : -v / 2 }
  const profile = read(8)
  read(16)
  ue()
  let chroma = 1
  let separate = 0
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
    chroma = ue()
    if (chroma === 3) separate = read(1)
    ue(); ue(); read(1)
    if (read(1)) {
      for (let i = 0; i < (chroma !== 3 ? 8 : 12); i++) {
        if (!read(1)) continue
        let last = 8
        let next = 8
        for (let j = 0; j < (i < 6 ? 16 : 64); j++) {
          if (next) next = (last + se() + 256) % 256
          last = next || last
        }
      }
    }
  }
  ue()
  const order = ue()
  if (order === 0) ue()
  else if (order === 1) { read(1); se(); se(); const count = ue(); for (let i = 0; i < count; i++) se() }
  ue(); read(1)
  const widthMbs = ue() + 1
  const heightMap = ue() + 1
  const frame = read(1)
  if (!frame) read(1)
  read(1)
  let left = 0, right = 0, top = 0, bottom = 0
  if (read(1)) { left = ue(); right = ue(); top = ue(); bottom = ue() }
  const chromaType = separate ? 0 : chroma
  const cropX = chromaType === 1 || chromaType === 2 ? 2 : 1
  const cropY = (chromaType === 1 ? 2 : 1) * (2 - frame)
  const width = widthMbs * 16 - (left + right) * cropX
  const height = (2 - frame) * heightMap * 16 - (top + bottom) * cropY
  if (width < 160 || height < 90 || width > 16384 || height > 16384) throw new Error('invalid_dimensions')
  return { width, height }
}

export async function readBounded(response, limit = 65536, { requireComplete = false } = {}) {
  if (!response.body?.getReader) {
    const data = new Uint8Array(await response.arrayBuffer())
    if (requireComplete && data.byteLength > limit) throw new Error('response_too_large')
    return data.slice(0, limit).buffer
  }
  const reader = response.body.getReader()
  const parts = []
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (size + value.byteLength > limit && requireComplete) throw new Error('response_too_large')
      const part = value.subarray(0, limit - size)
      parts.push(part)
      size += part.byteLength
      if (size >= limit && !requireComplete) break
    }
  } finally { await reader.cancel().catch(() => {}) }
  const out = new Uint8Array(size)
  let at = 0
  for (const part of parts) { out.set(part, at); at += part.byteLength }
  return out.buffer
}
