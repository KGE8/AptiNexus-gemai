import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Sparkles, Trash2 } from 'lucide-react'
import { useToast } from '../../contexts/ToastContext'
import { useAuth } from '../../contexts/AuthContext'
import { userSkills } from '../../data/careers'
import { loadProfile, type ProfileData } from '../../data/profile'
import { library } from '../../data/skills'
import { seedProjects, statusFor, type Evidence, type Project, type Result } from '../../data/evidence'
import { isHttpUrl } from '../../utils/store'
import { useRemote } from '../../hooks/useRemote'
import type { User } from '../../types'

export default function SkillProofPage() {
  const user = useAuth().user as User
  const uid = user?.id
  const toast = useToast()
  const [profile] = useRemote<ProfileData>('profile', uid, loadProfile(user))
  const [projects] = useRemote<Project[]>('projects', uid, seedProjects)
  const [ev, setEv] = useRemote<Evidence[]>('evidence', uid, [])
  const [res] = useRemote<Result[]>('results', uid, [])
  const [f, setF] = useState({ skill: library[0].name, type: 'Demonstration' as Evidence['type'], note: '', link: '' })
  const [err, setErr] = useState('')

  const add = () => {
    if (!f.note.trim()) return setErr('Describe the evidence.')
    if (f.link && !isHttpUrl(f.link)) return setErr('Enter a link starting with http:// or https://.')
    setErr('')
    setEv([...ev, { ...f, id: Date.now().toString(36) }])
    setF({ ...f, note: '', link: '' })
    toast.push('Evidence added')
  }

  const allSkillNames = useMemo(() => {
    const names = new Set<string>()
    for (const s of profile.sections?.technical ?? []) {
      if (s.trim()) names.add(s.trim())
    }
    for (const l of library) {
      if (
        userSkills.includes(l.name) ||
        ev.some(e => e.skill === l.name) ||
        projects.some(p => p.skills.includes(l.name)) ||
        res.some(r => r.skill === l.name)
      ) {
        names.add(l.name)
      }
    }
    return Array.from(names)
  }, [ev, profile.sections?.technical, projects, res])

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div>
        <h1 className="text-2xl font-semibold text-[#1d1d1f]">SkillProof</h1>
        <p className="text-sm text-[#6e6e73]">
          Claimed → Practised → Demonstrated → Verified. Passing a Gemini skill micro-test (≥70%) or adding evidence makes a skill Practised; a project or demonstration with a link makes it Demonstrated. Verified is never assigned automatically.
        </p>
      </div>
      <section className="glass grid gap-3 p-5 md:grid-cols-5" aria-label="Add evidence">
        <select aria-label="Skill" className="input" value={f.skill} onChange={e => setF({ ...f, skill: e.target.value })}>
          {Array.from(new Set([...library.map(l => l.name), ...allSkillNames])).map(name => (
            <option key={name}>{name}</option>
          ))}
        </select>
        <select aria-label="Evidence type" className="input" value={f.type} onChange={e => setF({ ...f, type: e.target.value as Evidence['type'] })}>
          {['Demonstration', 'Certification', 'Experience'].map(t => (
            <option key={t}>{t}</option>
          ))}
        </select>
        <input aria-label="What does it show?" className="input" placeholder="What does it show?" value={f.note} onChange={e => setF({ ...f, note: e.target.value })} />
        <input aria-label="Link (optional)" className="input" placeholder="Link (optional)" value={f.link} onChange={e => setF({ ...f, link: e.target.value })} />
        <button className="btn-primary" onClick={add}>
          Add evidence
        </button>
        {err && <p role="alert" className="text-xs text-[#d70015] md:col-span-5">{err}</p>}
      </section>
      <div className="space-y-3">
        {allSkillNames.map(skillName => {
          const st = statusFor(skillName, projects, ev, res)
          return (
            <article key={skillName} className="glass p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-medium text-[#1d1d1f]">{skillName}</h2>
                <div className="flex items-center gap-2">
                  {st === 'Claimed' && (
                    <Link
                      to={`/app/assessments?skill=${encodeURIComponent(skillName)}`}
                      className="btn-ghost !py-1 !px-2.5 text-xs"
                    >
                      <Sparkles size={13} className="text-[#007AFF]" />
                      Test with Gemini quiz
                    </Link>
                  )}
                  <span className="rounded-full border border-black/[0.08] px-3 py-0.5 text-sm">{st}</span>
                </div>
              </div>
              <ul className="mt-2 space-y-1 text-sm text-[#6e6e73]">
                {projects
                  .filter(p => p.skills.includes(skillName))
                  .map(p => (
                    <li key={p.id}>
                      Project: {p.title}
                      {p.link ? ' (linked)' : ' (no link)'}
                    </li>
                  ))}
                {res
                  .filter(r => r.skill.toLowerCase() === skillName.toLowerCase())
                  .map(r => (
                    <li key={r.id}>
                      Assessment: {r.score}/{r.total} on {r.date}
                    </li>
                  ))}
                {ev
                  .filter(e => e.skill === skillName)
                  .map(e => (
                    <li key={e.id} className="flex items-center gap-2">
                      {e.type}: {e.note}
                      {e.link && ' (linked)'}
                      <button aria-label={`Remove evidence: ${e.note}`} onClick={() => setEv(ev.filter(x => x.id !== e.id))}>
                        <Trash2 size={13} className="text-[#d70015]" />
                      </button>
                    </li>
                  ))}
                {st === 'Claimed' && <li>No evidence yet. Take a Gemini micro-test or link a project to prove this skill.</li>}
              </ul>
            </article>
          )
        })}
      </div>
    </div>
  )
}
