export const WATCH_HISTORY_KEY = 'kj-history'

export function readWatchHistory(storage, limit = 12) {
  try {
    const source = storage ?? globalThis.localStorage
    const value = JSON.parse(source.getItem(WATCH_HISTORY_KEY) || '[]')
    if (!Array.isArray(value)) return []
    return [...new Set(value.filter((id) => typeof id === 'string' && id.trim()))].slice(0, limit)
  } catch {
    return []
  }
}

export function recordWatchedShow(showId, storage, limit = 12) {
  if (typeof showId !== 'string' || !showId.trim()) return
  try {
    const source = storage ?? globalThis.localStorage
    const previous = readWatchHistory(source, limit).filter((id) => id !== showId)
    source.setItem(WATCH_HISTORY_KEY, JSON.stringify([showId, ...previous].slice(0, limit)))
  } catch {
    // 浏览器存储不可用时仍允许继续播放。
  }
}
