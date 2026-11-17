import { request } from './client'

const paths: Record<string, string> = {
  projects: '/projects',
  evidence: '/skillproof/evidence',
  results: '/assessments/results',
  settings: '/users/me/settings',
  notifRead: '/notifications/read',
  profile: '/profiles/me',
}
const pathOf = (name: string) => (name.startsWith('roadmap:') ? `/roadmaps/${name.slice(8)}/progress` : paths[name])

export const userData = {
  get: <T,>(name: string, _uid: string | undefined, _init: T) => request<T>(pathOf(name)),
  save: async <T,>(name: string, _uid: string | undefined, value: T) => {
    const saved = await request<T>(pathOf(name), { method: 'PUT', body: JSON.stringify(value) })
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('aptinexus:data-changed'))
    }
    return saved
  },
}
