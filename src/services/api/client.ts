export const API_BASE_URL: string = import.meta.env.VITE_API_BASE_URL ?? '/api/v1'
export const USE_MOCK: boolean = import.meta.env.VITE_USE_MOCK === 'true'
let accessToken: string | null = null
export const setAccessToken = (t: string | null) => { accessToken = t }

/** Single entry point for every API module. Calls the server API unless VITE_USE_MOCK=true. */
export async function request<T>(path: string, init: RequestInit | undefined, mock: () => Promise<T>): Promise<T> {
  if (USE_MOCK) return mock()
  const isForm = typeof FormData !== 'undefined' && init?.body instanceof FormData
  const headers = new Headers(init?.headers)
  if (!isForm && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`)
  const res = await fetch(`${API_BASE_URL}${path}`, { ...init, headers })
  if (!res.ok) {
    if (res.status === 401 && accessToken && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('aptinexus:unauthorized'))
    }
    const body = await res.json().catch(() => null) as { detail?: string } | null
    throw new Error(body?.detail || `Request failed (${res.status})`)
  }
  return res.json() as Promise<T>
}
