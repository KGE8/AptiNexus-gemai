import { useRef, useState } from 'react'
import { Check, FileUp, Pencil, Sparkles, X } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { useToast } from '../../contexts/ToastContext'
import { loadProfile, validateResume } from '../../data/profile'
import { profilesApi, resumeApi } from '../../services/api'
import type { ProfileCorrection, User } from '../../types'
import { applyProfileCorrection } from '../../utils/profileApply'

type Origin = 'explicit' | 'inferred' | 'confirmed'
interface Item {
  id: number
  section: string
  target: string | null
  text: string
  normalizedSkill?: string | null
  origin: Origin
  confidence?: 'high' | 'medium'
  rationale?: string
  state: 'pending' | 'approved' | 'rejected'
}

const originLabel: Record<Origin, string> = {
  explicit: 'Explicit in resume',
  inferred: 'Inferred from context',
  confirmed: 'Confirmed by you',
}

export default function ResumeAnalysisPage() {
  const user = useAuth().user as User
  const toast = useToast()
  const input = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [err, setErr] = useState('')
  const [items, setItems] = useState<Item[] | null>(null)
  const [corrections, setCorrections] = useState<ProfileCorrection[]>([])
  const [acceptedCorrIds, setAcceptedCorrIds] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [edit, setEdit] = useState<{ id: number; text: string } | null>(null)
  const [msg, setMsg] = useState('')
  const [analysisMessage, setAnalysisMessage] = useState('')
  const [mode, setMode] = useState<'gemini' | 'fallback' | undefined>(undefined)

  const pick = (f?: File) => {
    if (!f) return
    const e = validateResume(f)
    setErr(e ?? '')
    setFile(e ? null : f)
    setItems(null)
    setCorrections([])
    setAcceptedCorrIds(new Set())
    setMsg('')
    setAnalysisMessage('')
    setMode(undefined)
  }

  const run = async () => {
    if (!file || busy) return
    setBusy(true)
    setErr('')
    setItems(null)
    setCorrections([])
    setAcceptedCorrIds(new Set())
    try {
      const result = await resumeApi.analyse(file)
      setAnalysisMessage(result.message)
      setMode(result.mode)
      setItems(result.suggestions.map((s, i) => ({ ...s, id: i, state: 'pending' as const })))
      setCorrections(result.profileCorrections ?? [])
    } catch (error) {
      setErr(error instanceof Error ? error.message : 'Could not analyse this resume.')
    } finally {
      setBusy(false)
    }
  }

  const setItem = (id: number, patch: Partial<Item>) =>
    setItems(l => l && l.map(i => (i.id === id ? { ...i, ...patch } : i)))

  const acceptOne = async (item: Item) => {
    if (!item.target || saving) return
    setSaving(true)
    try {
      const p = await profilesApi.get(user.id, loadProfile(user))
      const valueToSave = item.normalizedSkill?.trim() || item.text
      if (item.target === 'name' || item.target === 'headline' || item.target === 'location') {
        p.personal[item.target] = valueToSave
        await profilesApi.save(user.id, p)
      } else {
        const cur = p.sections[item.target] ?? []
        if (!cur.some(x => x.toLowerCase() === valueToSave.toLowerCase())) {
          p.sections[item.target] = [...cur, valueToSave]
          await profilesApi.save(user.id, p)
        }
      }
      setItem(item.id, { state: 'approved', origin: 'confirmed' })
      toast.push(`Added to ${item.section}`)
    } catch {
      toast.push('Could not save item to profile.', 'error')
    } finally {
      setSaving(false)
    }
  }

  const acceptAllExplicit = async () => {
    if (!items || saving) return
    setSaving(true)
    try {
      const p = await profilesApi.get(user.id, loadProfile(user))
      let addedCount = 0
      const updated = items.map(i => {
        if (i.state !== 'rejected' && i.target && (i.origin === 'explicit' || i.state === 'approved')) {
          const val = i.normalizedSkill?.trim() || i.text
          if (i.target === 'name' || i.target === 'headline' || i.target === 'location') {
            if (p.personal[i.target] !== val) {
              p.personal[i.target] = val
              addedCount++
            }
          } else {
            const cur = p.sections[i.target] ?? []
            if (!cur.some(x => x.toLowerCase() === val.toLowerCase())) {
              p.sections[i.target] = [...cur, val]
              addedCount++
            }
          }
          return { ...i, state: 'approved' as const, origin: 'confirmed' as const }
        }
        return i
      })
      await profilesApi.save(user.id, p)
      setItems(updated)
      toast.push('Profile updated')
      setMsg(
        addedCount
          ? `Saved ${addedCount} resume item${addedCount > 1 ? 's' : ''} to your profile.`
          : 'All explicit items are already in your profile.',
      )
    } catch {
      toast.push('Could not save profile updates.', 'error')
    } finally {
      setSaving(false)
    }
  }

  const acceptCorrection = async (c: ProfileCorrection) => {
    if (saving) return
    setSaving(true)
    try {
      const p = await profilesApi.get(user.id, loadProfile(user))
      const next = applyProfileCorrection(p, c)
      await profilesApi.save(user.id, next)
      setAcceptedCorrIds(prev => new Set(prev).add(c.id))
      toast.push(`Applied correction to ${c.section}`)
    } catch {
      toast.push('Could not apply profile correction.', 'error')
    } finally {
      setSaving(false)
    }
  }

  const sections = items ? Array.from(new Set(items.map(i => i.section))) : []

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div>
        <h1 className="text-2xl font-semibold text-[#1d1d1f]">Resume Analysis</h1>
        <p className="text-sm text-[#6e6e73]">
          Upload a PDF or DOCX (max 5 MB). Gemini extracts explicit and inferred skills, compares them against your saved profile, and lets you accept changes in one click.
        </p>
      </div>
      <div
        className="glass flex flex-col items-center gap-3 border-dashed p-8 text-center"
        onDragOver={e => e.preventDefault()}
        onDrop={e => {
          e.preventDefault()
          pick(e.dataTransfer.files[0])
        }}
      >
        <FileUp className="text-[#007AFF]" />
        <input
          ref={input}
          type="file"
          className="sr-only"
          aria-label="Choose resume file"
          accept=".pdf,.docx"
          onChange={e => pick(e.target.files?.[0])}
        />
        <button className="btn-ghost" onClick={() => input.current?.click()}>
          Choose a file
        </button>
        {file && (
          <p className="text-sm text-[#1d1d1f]">
            {file.name}{' '}
            <span className="text-[#6e6e73] tabular-nums">
              · {(file.size / 1024).toFixed(0)} KB · {file.name.split('.').pop()?.toUpperCase()}
            </span>
          </p>
        )}
        {err && (
          <p role="alert" className="text-sm text-[#d70015]">
            {err}
          </p>
        )}
        {file && (
          <button className="btn-primary" disabled={busy} onClick={run}>
            {busy ? 'Analysing with Gemini…' : 'Analyse resume'}
          </button>
        )}
      </div>

      {items && (
        <>
          <div role="status" className="rounded-xl border border-[#007AFF]/20 bg-[#007AFF]/5 p-3.5 text-sm text-[#1d1d1f]">
            <p>{analysisMessage}</p>
            {mode && (
              <p className="mt-1 text-xs text-[#6e6e73]">
                {mode === 'gemini' ? 'Live Gemini semantic analysis' : 'Fallback heading extraction'}
              </p>
            )}
          </div>

          {corrections.length > 0 && (
            <section className="glass space-y-3 p-5" aria-label="Profile corrections from resume">
              <div className="flex items-center gap-2">
                <Sparkles size={16} className="text-[#007AFF]" aria-hidden />
                <h2 className="font-medium text-[#1d1d1f]">Profile Corrections &amp; Normalizations</h2>
              </div>
              <div className="space-y-2">
                {corrections.map(c => {
                  const accepted = acceptedCorrIds.has(c.id)
                  return (
                    <div
                      key={c.id}
                      className="flex flex-col justify-between gap-2 rounded-lg border border-black/[0.08] bg-white/60 px-3.5 py-2.5 sm:flex-row sm:items-center"
                    >
                      <div className="min-w-0">
                        <p className="text-xs text-[#6e6e73]">
                          {c.action} · {c.section}
                        </p>
                        <p className="text-sm font-medium text-[#1d1d1f]">
                          {c.currentValue ? `${c.currentValue} → ${c.suggestedValue}` : c.suggestedValue}
                        </p>
                        <p className="text-xs text-[#6e6e73]">{c.rationale}</p>
                      </div>
                      <button
                        type="button"
                        disabled={accepted || saving}
                        onClick={() => void acceptCorrection(c)}
                        className="btn-primary !py-1.5 !px-3 text-xs whitespace-nowrap shrink-0"
                      >
                        <Check size={14} />
                        {accepted ? 'Applied' : 'Accept'}
                      </button>
                    </div>
                  )
                })}
              </div>
            </section>
          )}

          {sections.map(sec => (
            <section key={sec} className="glass p-5">
              <h2 className="mb-3 font-medium text-[#1d1d1f]">{sec}</h2>
              <ul className="space-y-2">
                {items
                  .filter(i => i.section === sec)
                  .map(i => (
                    <li
                      key={i.id}
                      className={`flex flex-wrap items-center justify-between gap-2 rounded-lg bg-black/[0.04] px-3 py-2.5 text-sm ${
                        i.state === 'rejected' ? 'opacity-40 line-through' : ''
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        {edit?.id === i.id ? (
                          <input
                            autoFocus
                            className="input !py-1 w-full"
                            aria-label="Edit item"
                            value={edit.text}
                            onChange={e => setEdit({ id: i.id, text: e.target.value })}
                            onKeyDown={e => {
                              if (e.key === 'Enter') {
                                setItem(i.id, { text: edit.text.trim() || i.text })
                                setEdit(null)
                              }
                            }}
                          />
                        ) : (
                          <>
                            <p className="text-[#1d1d1f]">
                              {i.text}
                              {i.normalizedSkill && i.normalizedSkill !== i.text && (
                                <span className="ml-2 text-xs text-[#007AFF]">→ {i.normalizedSkill}</span>
                              )}
                            </p>
                            <p className="mt-0.5 text-xs text-[#6e6e73]">
                              {originLabel[i.origin]}
                              {i.confidence ? ` · ${i.confidence} confidence` : ''}
                              {i.rationale ? ` · ${i.rationale}` : ''}
                            </p>
                          </>
                        )}
                      </div>
                      {i.target && (
                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            type="button"
                            aria-label={`Edit ${i.text}`}
                            onClick={() => setEdit({ id: i.id, text: i.text })}
                            className="rounded-lg p-1.5 hover:bg-black/[0.06]"
                          >
                            <Pencil size={14} />
                          </button>
                          <button
                            type="button"
                            disabled={i.state === 'approved' || saving}
                            onClick={() => void acceptOne(i)}
                            className="btn-primary !py-1 !px-2.5 text-xs whitespace-nowrap shrink-0"
                          >
                            <Check size={14} />
                            {i.state === 'approved' ? 'Accepted' : 'Accept'}
                          </button>
                          {i.state !== 'approved' && (
                            <button
                              type="button"
                              aria-label={`Reject ${i.text}`}
                              onClick={() => setItem(i.id, { state: 'rejected' })}
                              className="rounded-lg p-1.5 text-[#d70015] hover:bg-black/[0.06]"
                            >
                              <X size={15} />
                            </button>
                          )}
                        </div>
                      )}
                    </li>
                  ))}
              </ul>
            </section>
          ))}

          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className="btn-primary" disabled={saving} onClick={() => void acceptAllExplicit()}>
              {saving ? 'Saving…' : 'Accept all explicit items'}
            </button>
            {msg && (
              <span role="status" className="text-sm text-[#007AFF]">
                {msg}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  )
}
