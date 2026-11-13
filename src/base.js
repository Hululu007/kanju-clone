// Resolve an app path against the deployment base (Vite's BASE_URL).
// Works both at the site root ("/") and under a sub-path such as
// "/kanju-clone/" on GitHub Pages.
export const BASE = import.meta.env.BASE_URL || '/'

export function u(path = '/') {
  const clean = String(path).replace(/^\/+/, '')
  return BASE + clean
}
