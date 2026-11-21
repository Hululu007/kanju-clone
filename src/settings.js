/**
 * 站点设置：网站设置面板与播放器齿轮菜单共用同一份值。
 *
 * 存储沿用站点既有 key（kj-speed / kj-hq / kj-dm / kj-fill），
 * iOS 注入层和旧的播放逻辑读的也是这几个，所以两边天然同源；
 * 新增项各自一个 key，改即存，没有「保存」按钮。
 */

export const SPEED_MIN = 0.5
export const SPEED_MAX = 3
export const SPEED_STEP = 0.25
export const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3]

const KEYS = {
  speed: 'kj-speed',
  enhance: 'kj-hq',
  danmaku: 'kj-dm',
  fill: 'kj-fill',
  skipIntro: 'kj-skip-intro',
  skipOutro: 'kj-skip-outro',
  p2p: 'kj-p2p',
  dmOpacity: 'kj-dm-opacity',
  dmSize: 'kj-dm-size',
  dmSpeed: 'kj-dm-speed',
  dmArea: 'kj-dm-area',
}

const DEFAULTS = {
  speed: 1,
  enhance: false,
  danmaku: true,
  fill: 'contain',
  skipIntro: true,
  skipOutro: false,
  p2p: false,
  dmOpacity: 0.9,
  dmSize: 18,
  dmSpeed: 8,
  dmArea: 100, // 弹幕显示区域：占画面高度百分比（100 = 全画面）
}

const NUMERIC = new Set(['speed', 'dmOpacity', 'dmSize', 'dmSpeed', 'dmArea'])

function raw(key) {
  try {
    return localStorage.getItem(KEYS[key])
  } catch {
    return null
  }
}

export function getSetting(key) {
  const stored = raw(key)
  if (stored === null || stored === undefined || stored === '') return DEFAULTS[key]
  if (NUMERIC.has(key)) {
    const value = Number(stored)
    return Number.isFinite(value) ? value : DEFAULTS[key]
  }
  if (typeof DEFAULTS[key] === 'boolean') return stored === '1'
  return stored
}

export function setSetting(key, value, { silent = false } = {}) {
  if (!(key in DEFAULTS)) return
  const stored = NUMERIC.has(key) ? String(value) : typeof value === 'boolean' ? (value ? '1' : '0') : String(value)
  try {
    localStorage.setItem(KEYS[key], stored)
  } catch {}
  if (!silent) {
    try {
      window.dispatchEvent(new CustomEvent('kj-settings', { detail: { key, value: getSetting(key) } }))
    } catch {}
  }
}

/** 监听设置变化（同一页内改值 + 其它标签页 storage 事件）。 */
export function onSettingChange(handler) {
  const local = (event) => handler(event.detail?.key, event.detail?.value)
  const remote = (event) => {
    for (const [key, storageKey] of Object.entries(KEYS)) {
      if (event.key === storageKey) handler(key, getSetting(key))
    }
  }
  window.addEventListener('kj-settings', local)
  window.addEventListener('storage', remote)
  return () => {
    window.removeEventListener('kj-settings', local)
    window.removeEventListener('storage', remote)
  }
}

export function clampRate(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 1
  const snapped = Math.round(number / SPEED_STEP) * SPEED_STEP
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, Number(snapped.toFixed(2))))
}

export function rateText(value) {
  return clampRate(value).toFixed(2)
}

export const FILL_MODES = [
  ['contain', '默认'],
  ['fill', '拉伸'],
  ['cover', '铺满'],
]

export const DM_AREA_MODES = [
  [25, '1/4 画面'],
  [50, '1/2 画面'],
  [75, '3/4 画面'],
  [100, '全画面'],
]
