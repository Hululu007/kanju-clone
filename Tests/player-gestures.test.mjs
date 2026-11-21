import test from 'node:test'
import assert from 'node:assert/strict'
import { createPictureClickHandlers, didTouchMove } from '../src/player-gestures.js'

const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))

test('touch movement used to seek exceeds the click threshold', () => {
  assert.equal(didTouchMove({ x: 10, y: 10 }, { x: 12, y: 16 }), false)
  assert.equal(didTouchMove({ x: 10, y: 10 }, { x: 10, y: 24 }), true)
})

test('single click toggles playback once after the double-click window', async () => {
  let played = 0
  let fullscreen = 0
  const handlers = createPictureClickHandlers({
    singleClick: () => played++,
    doubleClick: () => fullscreen++,
    delay: 10,
  })

  handlers.click()
  assert.equal(played, 0)
  await settle(20)
  assert.equal(played, 1)
  assert.equal(fullscreen, 0)
})

test('double click cancels the pending single click', async () => {
  let played = 0
  let fullscreen = 0
  const handlers = createPictureClickHandlers({
    singleClick: () => played++,
    doubleClick: () => fullscreen++,
    delay: 10,
  })

  handlers.click()
  handlers.click()
  handlers.doubleClick()
  await settle(20)
  assert.equal(played, 0)
  assert.equal(fullscreen, 1)
})

test('a new single click resets the timer without losing either callback', async () => {
  let played = 0
  let fullscreen = 0
  const handlers = createPictureClickHandlers({
    singleClick: () => played++,
    doubleClick: () => fullscreen++,
    delay: 10,
  })

  handlers.click()
  await settle(5)
  handlers.click()
  await settle(20)
  assert.equal(played, 1)
  assert.equal(fullscreen, 0)
})
