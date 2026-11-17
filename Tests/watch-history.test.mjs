import assert from 'node:assert/strict'
import test from 'node:test'
import { readWatchHistory, recordWatchedShow, WATCH_HISTORY_KEY } from '../src/watch-history.js'

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial))
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null },
    setItem(key, value) { values.set(key, String(value)) },
  }
}

test('reads valid unique show ids from the existing history format', () => {
  const storage = memoryStorage({ [WATCH_HISTORY_KEY]: '["movie-1","show-2","movie-1",null,""]' })
  assert.deepEqual(readWatchHistory(storage), ['movie-1', 'show-2'])
})

test('recorder moves the watched show to the front without changing the history format', () => {
  const storage = memoryStorage({ [WATCH_HISTORY_KEY]: '["movie-1","show-2"]' })
  recordWatchedShow('show-2', storage)
  assert.equal(storage.getItem(WATCH_HISTORY_KEY), '["show-2","movie-1"]')
})

test('bad or unavailable history storage safely returns an empty list', () => {
  assert.deepEqual(readWatchHistory(memoryStorage({ [WATCH_HISTORY_KEY]: '{bad json' })), [])
  assert.deepEqual(readWatchHistory({ getItem() { throw new Error('storage disabled') } }), [])
})
