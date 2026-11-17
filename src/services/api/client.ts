function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '')
  if (!trimmed) return '/api/v1'
  if (/^https?:\/\//i.test(trimmed) && !trimmed.endsWith('/api/v1')) {
    return `${trimmed}/api/v1`
  }
  return trimmed
}

const configuredBase = normalizeBaseUrl(import.meta.env.VITE_API_BASE_URL ?? '')
export const API_BASE_URL: string = configuredBase
export const USE_MOCK = false

let activeBaseUrl: string = API_BASE_URL
let accessToken: string | null = null
export const setAccessToken = (t: string | null) => {
  accessToken = t
}

function isHtmlResponse(res: Response, text: string): boolean {
  const ct = (res.headers.get('content-type') ?? '').toLowerCase()
  const trimmed = text.trimStart().slice(0, 32).toLowerCase()
  return ct.includes('text/html') || trimmed.startsWith('<!doctype') || trimmed.startsWith('<html')
}

function candidateBases(): string[] {
  const list = [activeBaseUrl, API_BASE_URL, '/api/v1']
  if (typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')) {
    list.push('http://localhost:3000/api/v1', 'http://localhost:8000/api/v1')
  }
  return Array.from(new Set(list))
}

/** Single entry point for every API module. Always calls the live server API (mock mode disabled). */
export async function request<T>(path: string, init?: RequestInit, _legacyMock?: () => Promise<T>): Promise<T> {
  const isForm = typeof FormData !== 'undefined' && init?.body instanceof FormData
  const headers = new Headers(init?.headers)
  if (!isForm && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  if (headers.get('Accept') == null) headers.set('Accept', 'application/json')
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`)

  const bases = candidateBases()
  let lastRes: Response | null = null
  let lastText = ''
  let lastErr: unknown = null
  let receivedHtml = false

  for (const base of bases) {
    try {
      const res = await fetch(`${base}${path}`, { ...init, headers })
      const text = await res.text()
      if (isHtmlResponse(res, text)) {
        receivedHtml = true
        continue
      }
      activeBaseUrl = base
      lastRes = res
      lastText = text
      break
    } catch (err) {
      lastErr = err
    }
  }

  if (!lastRes) {
    if (receivedHtml) {
      throw new Error(
        'The dev server returned HTML (<!doctype html>) instead of JSON. Make sure you start the full-stack server with "npm run dev" (tsx server.ts on port 3000) or run the FastAPI backend on port 8000.',
      )
    }
    throw lastErr instanceof Error ? lastErr : new Error('Could not connect to the AptiNexus API server.')
  }

  let parsed: unknown = null
  if (lastText.trim()) {
    try {
      parsed = JSON.parse(lastText)
    } catch {
      throw new Error(`Invalid JSON response from API (${lastRes.status})`)
    }
  }

  if (!lastRes.ok) {
    if (lastRes.status === 401 && accessToken && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('aptinexus:unauthorized'))
    }
    const body = parsed as { detail?: string } | null
    throw new Error(body?.detail || `Request failed (${lastRes.status})`)
  }
  return parsed as T
}
