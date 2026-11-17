import { useCallback, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import CareerPicker from '../../components/careers/CareerPicker'
import AiAdvisorPanel from '../../components/ai/AiAdvisorPanel'
import { useAuth } from '../../contexts/AuthContext'
import { careers } from '../../data/careers'
import { seedProjects, statusFor, type Evidence, type Project, type Result } from '../../data/evidence'
import { analyse, byName, priorityOf, type Priority } from '../../data/skills'
import { useRemote } from '../../hooks/useRemote'
import { gapsApi } from '../../services/api'
import { loadProfile, type ProfileData } from '../../data/profile'

const order: Priority[] = ['Essential', 'Recommended', 'Specialization-specific', 'Optional']
interface GapResult { strengths: string[]; missing: string[]; optional: string[]; method?: string }

export default function SkillGapPage() {
  const { user } = useAuth()
  const uid = user?.id
  const [sp, setSp] = useSearchParams()
  const career = careers.find(c => c.id === sp.get('career')) ?? careers[0]
  const [profile] = useRemote<ProfileData>('profile', uid, loadProfile(user))
  const [projects] = useRemote<Project[]>('projects', uid, seedProjects)
  const [evidence] = useRemote<Evidence[]>('evidence', uid, [])
  const [results] = useRemote<Result[]>('results', uid, [])
  const [result, setResult] = useState<GapResult>(() => analyse(career))
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const loadGaps = useCallback(() => {
    let active = true
    setLoading(true); setError('')
    gapsApi.analyse(career.id).then(data => {
      if (active && data) setResult(data as GapResult)
    }).catch(e => {
      if (active) setError(e instanceof Error ? e.message : 'Could not calculate skill gaps.')
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [career.id])

  useEffect(() => loadGaps(), [loadGaps])

  const liveStatusOf = (skill: string) => {
    const st = statusFor(skill, projects, evidence, results)
    if (st !== 'Not started') return st
    const inProfile = (profile.sections.technical ?? []).some(t => t.toLowerCase() === skill.toLowerCase())
    return inProfile ? 'Claimed' : 'Claimed'
  }

  const { strengths, missing, optional } = result
  const items = [...missing.map(s => ({ s, p: priorityOf(career, s) })), ...optional.map(s => ({ s, p: 'Optional' as Priority }))]
  const coverage = career.required.length ? Math.round((strengths.length / career.required.length) * 100) : 0
  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3"><div><h1 className="text-2xl font-semibold text-[#1d1d1f]">Skill Gap Analysis</h1><p className="text-sm text-[#6e6e73]">Compares skills in your saved profile and evidence with this career's listed requirements.</p></div>
        <CareerPicker value={career.id} onChange={id => setSp({ career: id })} /></div>
      {loading && <p className="glass p-4 text-sm text-[#6e6e73]">Calculating your skill gaps…</p>}
      {error && <p role="alert" className="text-sm text-[#d70015]">{error}</p>}
      <div className="grid gap-4 md:grid-cols-3">
        <div className="glass p-5"><p className="text-sm text-[#6e6e73]">Skill coverage</p><p className="text-3xl text-[#1d1d1f]">{coverage}%</p>
          <div className="mt-2 h-2 rounded-full bg-black/[0.05]" role="progressbar" aria-valuenow={coverage} aria-valuemin={0} aria-valuemax={100}><div className="h-2 rounded-full bg-nexus-cyan" style={{ width: `${coverage}%` }} /></div>
          <p className="mt-3 text-xs text-[#6e6e73]">{strengths.length} of {career.required.length} required skills listed</p></div>
        <section className="glass p-5 md:col-span-2"><h2 className="mb-2 font-medium text-[#1d1d1f]">Current strengths</h2>
          {strengths.length ? (
            <div className="flex flex-wrap gap-2">
              {strengths.map(s => {
                const st = liveStatusOf(s)
                return (
                  <span key={s} className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/30 px-3 py-1 text-sm">
                    <span>{s}</span>
                    <span className="text-xs text-[#6e6e73]">· {st}</span>
                    {st === 'Claimed' && (
                      <Link to={`/app/assessments?skill=${encodeURIComponent(s)}`} className="ml-1 text-xs font-medium text-[#007AFF] hover:underline">
                        Verify
                      </Link>
                    )}
                  </span>
                )
              })}
            </div>
          ) : <p className="text-sm text-[#6e6e73]">No matching skills yet. Start with an Essential skill below.</p>}</section>
      </div>
      {missing.length === 0 && <p className="glass p-5">You have listed every required skill for this career. This is not an independent verification of proficiency.</p>}
      {order.map(p => { const g = items.filter(i => i.p === p); return g.length > 0 && (
        <section key={p}><h2 className="mb-2 font-medium text-[#1d1d1f]">{p}</h2>
          <div className="grid gap-3 md:grid-cols-2">{g.map(({ s }) => { const l = byName(s); const need = l?.prereqs.filter(r => !strengths.includes(r)) ?? []
            return <article key={s} className="glass p-4"><div className="flex justify-between"><h3 className="text-[#1d1d1f]">{s}</h3><span className="text-xs text-[#6e6e73]">{l?.difficulty}</span></div>
              <p className="mt-1 text-sm">{l?.desc}</p>
              <p className="mt-2 text-xs text-[#6e6e73]">Depends on: {l?.prereqs.join(', ') || 'nothing'}{need.length ? ` (not yet listed: ${need.join(', ')})` : ''}</p>
              <p className="mt-1 text-xs text-[#007AFF]">Suggested project: a small {career.title.toLowerCase()} exercise that uses {s}.</p></article> })}</div></section>) })}
      <AiAdvisorPanel focus="courses" focusCareerId={career.id} onApplied={loadGaps} />
      <p className="glass p-4 text-sm">Recommended learning for this career: {career.learn.join(', ')}.</p>
      <p className="text-xs text-[#6e6e73]">Method: {result.method ?? 'Compares your listed skills with the career requirements.'} Scores are guidance, not hiring predictions.</p>
    </div>
  )
}
