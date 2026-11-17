import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, RefreshCw } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { useRemote } from '../../hooks/useRemote'
import { notificationsApi } from '../../services/api'
import type { NotificationItem } from '../../types'

export default function NotificationsPage() {
  const uid = useAuth().user?.id
  const [read, setRead] = useRemote<string[]>('notifRead', uid, [])
  const [items, setItems] = useState<NotificationItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [type, setType] = useState('All')

  const loadNotifications = useCallback(() => {
    setLoading(true)
    setError('')
    notificationsApi
      .list()
      .then(setItems)
      .catch(e => setError(e instanceof Error ? e.message : 'Could not load notifications.'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    loadNotifications()
  }, [loadNotifications])

  const types = ['All', ...Array.from(new Set(items.map(i => i.type)))]
  const list = items.filter(i => type === 'All' || i.type === type)
  const unreadCount = items.filter(i => !read.includes(i.id)).length

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-[#1d1d1f]">Notifications</h1>
          <p className="text-sm text-[#6e6e73]">
            Live activity alerts generated from your saved profile, SkillProof status, assessment scores, and roadmap progress.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" className="btn-ghost !py-1.5" onClick={loadNotifications} disabled={loading}>
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
          {items.length > 0 && (
            <button
              type="button"
              className="btn-ghost !py-1.5"
              disabled={unreadCount === 0}
              onClick={() => setRead(Array.from(new Set([...read, ...items.map(i => i.id)])))}
            >
              Mark all as read
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <select
          className="input !w-auto"
          aria-label="Filter by type"
          value={type}
          onChange={e => setType(e.target.value)}
        >
          {types.map(t => (
            <option key={t}>{t}</option>
          ))}
        </select>
        <span className="tabular-nums text-xs text-[#6e6e73]">
          {unreadCount} unread · {items.length} total
        </span>
      </div>

      {loading && <p className="glass p-6 text-sm text-[#6e6e73]">Checking your account activity…</p>}
      {error && (
        <div role="alert" className="glass flex items-center justify-between p-4 text-sm text-[#d70015]">
          <span>{error}</span>
          <button type="button" className="btn-ghost !py-1" onClick={loadNotifications}>
            Retry
          </button>
        </div>
      )}

      {!loading && !error && list.length === 0 && (
        <p className="glass p-6 text-sm text-[#6e6e73]">No notifications in this category right now.</p>
      )}

      {!loading && !error && list.length > 0 && (
        <ul className="space-y-2.5">
          {list.map(i => {
            const isRead = read.includes(i.id)
            return (
              <li
                key={i.id}
                className={`glass flex flex-col justify-between gap-3 p-4 sm:flex-row sm:items-center ${
                  isRead ? 'opacity-65' : ''
                }`}
              >
                <div className="space-y-1">
                  <p className="text-xs text-[#6e6e73]">
                    {i.type}
                    {!isRead && <span className="font-medium text-[#007AFF]"> · Unread</span>}
                  </p>
                  <p className="text-sm text-[#1d1d1f]">{i.text}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {i.link && (
                    <Link
                      to={i.link}
                      onClick={() => {
                        if (!isRead) setRead([...read, i.id])
                      }}
                      className="btn-primary !py-1.5 !px-3 text-xs whitespace-nowrap"
                    >
                      {i.actionLabel ?? 'Open'}
                      <ArrowRight size={13} />
                    </Link>
                  )}
                  <button
                    type="button"
                    className="btn-ghost !py-1.5 !px-2.5 text-xs whitespace-nowrap"
                    onClick={() => setRead(isRead ? read.filter(x => x !== i.id) : [...read, i.id])}
                  >
                    {isRead ? 'Mark unread' : 'Mark read'}
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
