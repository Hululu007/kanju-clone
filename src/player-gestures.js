export function createPictureClickHandlers({ singleClick, doubleClick, delay = 240 }) {
  let timer = null

  return {
    click() {
      clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        singleClick()
      }, delay)
    },
    doubleClick() {
      clearTimeout(timer)
      timer = null
      doubleClick()
    },
    cancel() {
      clearTimeout(timer)
      timer = null
    },
  }
}

export function didTouchMove(start, end, threshold = 10) {
  if (!start || !end) return false
  return Math.hypot(end.x - start.x, end.y - start.y) > threshold
}
