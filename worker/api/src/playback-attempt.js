// Feedback credentials prove which playback response was issued, not that media played.
// Keep them outside the shared media cache and bind them to one authenticated user.
const TTL_MS = 30 * 60_000
const encoder = new TextEncoder()

async function signingKey(secret, usage) {
  if (!secret) throw new Error('Missing playback signing secret')
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage])
}

export async function issuePlaybackAttempt(secret, userId, play) {
  const claims = {
    nonce: crypto.randomUUID(),
    userId,
    showId: play.showId,
    idx: play.idx,
    provider: play.provider,
    expiresAt: Date.now() + TTL_MS,
  }
  const bytes = encoder.encode(JSON.stringify(claims))
  const payload = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const message = `playback-result:v1.${payload}`
  const signature = await crypto.subtle.sign('HMAC', await signingKey(secret, 'sign'), encoder.encode(message))
  const mac = [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `v1.${payload}.${mac}`
}

export async function verifyPlaybackAttempt(secret, token, userId, showId, provider) {
  if (typeof token !== 'string' || token.length > 4096) return false
  const match = /^v1\.([A-Za-z0-9_-]+)\.([a-f0-9]{64})$/.exec(token)
  if (!match) return false
  try {
    const [, payload, mac] = match
    const signature = Uint8Array.from(mac.match(/../g), (pair) => parseInt(pair, 16))
    const verified = await crypto.subtle.verify(
      'HMAC', await signingKey(secret, 'verify'), signature,
      encoder.encode(`playback-result:v1.${payload}`),
    )
    if (!verified) return false
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/')
    const bytes = Uint8Array.from(atob(base64 + '='.repeat((4 - base64.length % 4) % 4)), (char) => char.charCodeAt(0))
    const claims = JSON.parse(new TextDecoder().decode(bytes))
    const now = Date.now()
    return claims.userId === userId && claims.showId === showId && claims.provider === provider
      && Number.isInteger(claims.idx) && claims.idx >= 0
      && typeof claims.nonce === 'string' && /^[0-9a-f-]{36}$/i.test(claims.nonce)
      && Number.isFinite(claims.expiresAt) && claims.expiresAt > now && claims.expiresAt <= now + TTL_MS
  } catch {
    return false
  }
}
