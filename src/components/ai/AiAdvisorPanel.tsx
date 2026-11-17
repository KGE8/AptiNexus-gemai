import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, Check, ExternalLink, RefreshCw, Sparkles, X } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { useToast } from '../../contexts/ToastContext'
import { loadProfile } from '../../data/profile'
import { aiApi, profilesApi } from '../../services/api'
import type { AiRecommendationsResult, ProfileCorrection, User } from '../../types'
import { addSkillToProfile, applyProfileCorrection } from '../../utils/profileApply'

type Tab = 'corrections' | 'careers' | 'courses'

interface Props {
  focus?: 'all' | Tab
  focusCareerId?: string
  onApplyCorrection?: (correction: ProfileCorrection) => Promise<void> | void
  onApplySkill?: (skillName: string) => Promise<void> | void
  onApplied?: () => void
}

const sectionLabels: Record<string, string> = {
  education: 'Education',
  subjects: 'Academic subjects',
  technical: 'Technical skills',
  soft: 'Soft skills',
  interests: 'Interests',
  experience: 'Work experience',
  projects: 'Projects',
  certifications: 'Certifications',
  achievements: 'Achievements',
  goals: 'Career goals',
  name: 'Full name',
  headline: 'Headline',
  location: 'Location',
}

export default function AiAdvisorPanel({ focus = 'all', focusCareerId, onApplyCorrection, onApplySkill, onApplied }: Props) {
  const user = useAuth().user as User
  const toast = useToast()
  const [data, setData] = useState<AiRecommendationsResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [customGoal, setCustomGoal] = useState('')
  const [tab, setTab] = useState<Tab>(focus === 'all' ? 'corrections' : focus)
  const [acceptedIds, setAcceptedIds] = useState<Set<string>>(new Set())
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set())
  const [busyId, setBusyId] = useState<string | null>(null)

  const runScan = useCallback(async (goalOverride?: string) => {
    setLoading(true)
    setError('')
    try {
      const result = await aiApi.recommendations({
        focusCareerId,
        customGoal: (goalOverride ?? customGoal).trim() || undefined,
      })
      setData(result)
      setAcceptedIds(new Set())
      setDismissedIds(new Set())
      if (focus === 'all' && result.profileCorrections.length === 0) {
        setTab('careers')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not analyze your profile right now.')
    } finally {
      setLoading(false)
    }
  }, [customGoal, focus, focusCareerId])

  useEffect(() => {
    void runScan('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusCareerId])

  const handleAcceptCorrection = async (correction: ProfileCorrection) => {
    setBusyId(correction.id)
    try {
      if (onApplyCorrection) {
        await onApplyCorrection(correction)
      } else {
        const current = await profilesApi.get(user.id, loadProfile(user))
        const updated = applyProfileCorrection(current, correction)
        await profilesApi.save(user.id, updated)
      }
      setAcceptedIds(prev => new Set(prev).add(correction.id))
      toast.push(`Applied to ${sectionLabels[correction.section] ?? correction.section}`)
      onApplied?.()
    } catch {
      toast.push('Could not save that profile update.', 'error')
    } finally {
      setBusyId(null)
    }
  }

  const handleAddSkill = async (itemId: string, skillName: string) => {
    setBusyId(itemId)
    try {
      if (onApplySkill) {
        await onApplySkill(skillName)
      } else {
        const current = await profilesApi.get(user.id, loadProfile(user))
        const { profile: updated, added } = addSkillToProfile(current, skillName)
        if (added) await profilesApi.save(user.id, updated)
      }
      setAcceptedIds(prev => new Set(prev).add(itemId))
      toast.push(`Added ${skillName} to Technical skills`)
      onApplied?.()
    } catch {
      toast.push('Could not add skill to your profile.', 'error')
    } finally {
      setBusyId(null)
    }
  }

  const dismiss = (id: string) => setDismissedIds(prev => new Set(prev).add(id))

  const visibleCorrections = (data?.profileCorrections ?? []).filter(c => !dismissedIds.has(c.id))
  const visibleCareers = (data?.careerSuggestions ?? []).filter(c => !dismissedIds.has(c.careerId))
  const visibleCourses = (data?.courseRecommendations ?? []).filter(c => !dismissedIds.has(c.id))

  const tabs: { id: Tab; label: string; count: number }[] = [
    { id: 'corrections', label: 'Profile Corrections', count: visibleCorrections.length },
    { id: 'careers', label: 'Career Targets', count: visibleCareers.length },
    { id: 'courses', label: 'Course Suggestions', count: visibleCourses.length },
  ]

  const activeTab = focus === 'all' ? tab : focus

  return (
    <section className="glass space-y-4 p-5" aria-label="Gemini AI Advisor">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Sparkles size={17} className="text-[#007AFF]" aria-hidden />
            <h2 className="text-lg font-semibold text-[#1d1d1f]">AI Profile &amp; Career Advisor</h2>
          </div>
          <p className="mt-1 text-sm text-[#6e6e73]">
            Scans your saved profile, interests, projects, and evidence against the career catalog. Review and accept any suggestion in one click.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void runScan()}
          disabled={loading}
          className="btn-primary whitespace-nowrap shrink-0"
        >
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
          {loading ? 'Scanning…' : 'Scan profile'}
        </button>
      </div>

      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={e => {
          e.preventDefault()
          void runScan()
        }}
      >
        <input
          className="input flex-1"
          placeholder="Optional focus or interest to explore (e.g. autonomous drones, industrial AI, product)"
          aria-label="Optional interest or career focus"
          value={customGoal}
          onChange={e => setCustomGoal(e.target.value)}
        />
        <button type="submit" disabled={loading} className="btn-ghost whitespace-nowrap shrink-0">
          Update suggestions
        </button>
      </form>

      {loading && (
        <div className="space-y-2.5" aria-busy="true" aria-label="Analyzing your profile">
          <div className="h-14 animate-pulse rounded-xl bg-black/[0.04]" />
          <div className="h-20 animate-pulse rounded-xl bg-black/[0.04]" />
        </div>
      )}

      {!loading && error && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#d70015]/25 bg-[#d70015]/5 p-4 text-sm text-[#d70015]">
          <span>{error}</span>
          <button type="button" className="btn-ghost !py-1.5" onClick={() => void runScan()}>
            Retry
          </button>
        </div>
      )}

      {!loading && !error && data && (
        <>
          <div className="border-t border-black/[0.08] pt-3">
            <p className="text-sm text-[#1d1d1f]">{data.summary}</p>
            <p className="mt-1 text-xs text-[#6e6e73]">
              {data.mode === 'gemini' ? 'Live Gemini analysis' : 'Catalog fallback active'}
              {data.notice ? ` · ${data.notice}` : ''}
            </p>
          </div>

          {focus === 'all' && (
            <div role="tablist" aria-label="AI suggestion categories" className="flex flex-wrap gap-1.5 border-b border-black/[0.08] pb-3">
              {tabs.map(t => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={activeTab === t.id}
                  onClick={() => setTab(t.id)}
                  className={`btn-ghost !py-1.5 whitespace-nowrap shrink-0 ${
                    activeTab === t.id ? 'bg-[#007AFF]/10 text-[#0062cc] border-[#007AFF]/30' : ''
                  }`}
                >
                  {t.label} <span className="tabular-nums text-xs opacity-75">({t.count})</span>
                </button>
              ))}
            </div>
          )}

          {activeTab === 'corrections' && (
            <div className="space-y-2.5">
              {visibleCorrections.length === 0 ? (
                <p className="text-sm text-[#6e6e73]">
                  No pending profile corrections. Your skills and projects look well aligned with the catalog.
                </p>
              ) : (
                visibleCorrections.map(c => {
                  const accepted = acceptedIds.has(c.id)
                  const isBusy = busyId === c.id
                  return (
                    <div key={c.id} className="flex flex-col justify-between gap-3 rounded-xl border border-black/[0.08] bg-white/60 p-3.5 sm:flex-row sm:items-center">
                      <div className="min-w-0 flex-1 space-y-1">
                        <p className="text-xs text-[#6e6e73]">
                          {c.action === 'normalize' ? 'Normalize' : c.action === 'refine' ? 'Refine' : 'Suggested addition'} · {sectionLabels[c.section] ?? c.section}
                        </p>
                        <p className="text-sm font-medium text-[#1d1d1f]">
                          {c.currentValue ? `${c.currentValue} → ${c.suggestedValue}` : c.suggestedValue}
                        </p>
                        <p className="text-xs text-[#6e6e73]">{c.rationale}</p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          disabled={accepted || isBusy}
                          onClick={() => void handleAcceptCorrection(c)}
                          className="btn-primary !py-1.5 !px-3 text-xs whitespace-nowrap shrink-0"
                        >
                          <Check size={14} />
                          {accepted ? 'Accepted' : isBusy ? 'Saving…' : 'Accept'}
                        </button>
                        {!accepted && (
                          <button
                            type="button"
                            aria-label={`Dismiss ${c.suggestedValue}`}
                            onClick={() => dismiss(c.id)}
                            className="btn-ghost !py-1.5 !px-2.5 text-xs"
                          >
                            <X size={14} />
                          </button>
                        )}
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          )}

          {activeTab === 'careers' && (
            <div className="grid gap-3 md:grid-cols-2">
              {visibleCareers.length === 0 ? (
                <p className="text-sm text-[#6e6e73] md:col-span-2">
                  Add a few interests, subjects, or projects to your profile and scan again for career suggestions.
                </p>
              ) : (
                visibleCareers.map(c => (
                  <div key={c.careerId} className="flex flex-col justify-between gap-3 rounded-xl border border-black/[0.08] bg-white/60 p-4">
                    <div className="space-y-1.5">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-xs text-[#6e6e73]">
                            {c.category}
                            {c.isAdjacentDiscovery ? ' · Adjacent discovery' : ' · Strong fit'}
                          </p>
                          <h3 className="font-medium text-[#1d1d1f]">{c.title}</h3>
                        </div>
                        <span className="tabular-nums text-sm font-semibold text-[#007AFF]">~{c.compatibility}%</span>
                      </div>
                      <p className="text-sm text-[#3a3a3c]">{c.rationale}</p>
                      {c.matchedSkills.length > 0 && (
                        <p className="text-xs text-[#6e6e73]">
                          Matching: <span className="text-[#1d1d1f]">{c.matchedSkills.join(', ')}</span>
                        </p>
                      )}
                      {c.bridgeSkills.length > 0 && (
                        <p className="text-xs text-[#b25000]">
                          Bridge skills: {c.bridgeSkills.join(', ')}
                        </p>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2 border-t border-black/[0.06] pt-2.5">
                      <Link to={`/app/gaps?career=${c.careerId}`} className="btn-ghost !py-1 !px-2.5 text-xs whitespace-nowrap shrink-0">
                        Analyse gaps <ArrowRight size={13} />
                      </Link>
                      <Link to={`/app/roadmap?career=${c.careerId}`} className="btn-ghost !py-1 !px-2.5 text-xs whitespace-nowrap shrink-0">
                        Open roadmap
                      </Link>
                      {c.bridgeSkills[0] && (
                        <button
                          type="button"
                          disabled={acceptedIds.has(`bridge-${c.careerId}`) || busyId === `bridge-${c.careerId}`}
                          onClick={() => void handleAddSkill(`bridge-${c.careerId}`, c.bridgeSkills[0])}
                          className="btn-primary !py-1 !px-2.5 text-xs whitespace-nowrap shrink-0"
                        >
                          <Check size={13} />
                          {acceptedIds.has(`bridge-${c.careerId}`) ? `Added ${c.bridgeSkills[0]}` : `Track ${c.bridgeSkills[0]}`}
                        </button>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {activeTab === 'courses' && (
            <div className="grid gap-3 md:grid-cols-2">
              {visibleCourses.length === 0 ? (
                <p className="text-sm text-[#6e6e73] md:col-span-2">No course recommendations yet. Click Scan profile to refresh.</p>
              ) : (
                visibleCourses.map(course => {
                  const accepted = acceptedIds.has(course.id)
                  const isBusy = busyId === course.id
                  return (
                    <div key={course.id} className="flex flex-col justify-between gap-3 rounded-xl border border-black/[0.08] bg-white/60 p-4">
                      <div className="space-y-1">
                        <p className="text-xs text-[#6e6e73]">
                          {course.type} · {course.level} · {course.targetSkill}
                        </p>
                        <h3 className="font-medium text-[#1d1d1f]">{course.title}</h3>
                        <p className="text-sm text-[#3a3a3c]">{course.reason}</p>
                      </div>
                      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-black/[0.06] pt-2.5">
                        {course.url ? (
                          <a
                            href={course.url}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="inline-flex items-center gap-1 text-xs font-medium text-[#007AFF] hover:underline"
                          >
                            Open resource <ExternalLink size={12} />
                          </a>
                        ) : (
                          <span className="text-xs text-[#6e6e73]">Catalog guidance</span>
                        )}
                        <button
                          type="button"
                          disabled={accepted || isBusy}
                          onClick={() => void handleAddSkill(course.id, course.targetSkill)}
                          className="btn-primary !py-1 !px-2.5 text-xs whitespace-nowrap shrink-0"
                        >
                          <Check size={13} />
                          {accepted ? 'Skill added' : isBusy ? 'Saving…' : `Add ${course.targetSkill}`}
                        </button>
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          )}
        </>
      )}
    </section>
  )
}
