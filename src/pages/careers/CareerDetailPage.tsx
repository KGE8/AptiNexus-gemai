import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import AiAdvisorPanel from '../../components/ai/AiAdvisorPanel'
import { careerDetail, careerMeta, careers as fallbackCareers, type Career } from '../../data/careers'
import { resources as fallbackResources, type Resource } from '../../data/resources'
import { careersApi, gapsApi, resourcesApi } from '../../services/api'

const List = ({ title, items }: { title: string; items: string[] }) => (
  <section className="glass p-5">
    <h2 className="mb-2 font-medium text-[#1d1d1f]">{title}</h2>
    <ul className="list-inside list-disc space-y-1 text-sm">
      {items.map(i => (
        <li key={i}>{i}</li>
      ))}
    </ul>
  </section>
)

export default function CareerDetailPage() {
  const { id } = useParams()
  const [career, setCareer] = useState<Career | null>(() => fallbackCareers.find(x => x.id === id) ?? null)
  const [strengths, setStrengths] = useState<string[]>([])
  const [optional, setOptional] = useState<string[]>([])
  const [resources, setResources] = useState<Resource[]>(fallbackResources)
  const [loading, setLoading] = useState(true)

  const loadCareerDetail = useCallback(() => {
    if (!id) return
    setLoading(true)
    Promise.all([careersApi.get(id), gapsApi.analyse(id), resourcesApi.list()])
      .then(([c, gaps, resList]) => {
        if (c) setCareer(c)
        if (gaps) {
          setStrengths(gaps.strengths ?? [])
          setOptional(gaps.optional ?? [])
        }
        if (Array.isArray(resList)) setResources(resList)
      })
      .catch(() => {
        // Fallback catalog metadata already initialized
      })
      .finally(() => setLoading(false))
  }, [id])

  useEffect(() => {
    loadCareerDetail()
  }, [loadCareerDetail])

  if (!career) {
    return (
      <div className="glass mx-auto max-w-lg p-6">
        That career wasn’t found.{' '}
        <Link className="text-[#007AFF]" to="/app/explore">
          Browse all careers
        </Link>
      </div>
    )
  }

  const d = careerDetail[career.id]
  const m = careerMeta[career.id]
  const strengthSet = new Set(strengths.map(s => s.toLowerCase()))
  const compatibility = career.required.length
    ? Math.round((100 * career.required.filter(s => strengthSet.has(s.toLowerCase())).length) / career.required.length)
    : 0
  const res = resources.filter(r => career.required.includes(r.skill)).slice(0, 4)

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div>
        <p className="tabular-nums text-sm text-[#6e6e73]">
          {career.category} · profile compatibility ~{compatibility}%{loading ? ' (updating…)' : ''}
        </p>
        <h1 className="text-2xl font-semibold text-[#1d1d1f]">{career.title}</h1>
        <p className="mt-2">{d?.overview ?? career.why}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Link className="btn-primary" to={`/app/gaps?career=${career.id}`}>
            Analyse my skill gaps
          </Link>
          <Link className="btn-ghost" to={`/app/roadmap?career=${career.id}`}>
            Open roadmap
          </Link>
        </div>
      </div>

      <AiAdvisorPanel focus="courses" focusCareerId={career.id} onApplied={loadCareerDetail} />

      <div className="grid gap-4 md:grid-cols-2">
        {d && <List title="Typical responsibilities" items={d.resp} />}
        <List
          title="Required skills"
          items={career.required.map(s => `${s} ${strengthSet.has(s.toLowerCase()) ? '(in your profile)' : '(missing)'}`)}
        />
        <List title="Recommended adjacent skills" items={optional.length ? optional : ['All related catalog skills are already in your profile']} />
        {m && <List title="Education" items={[m.education]} />}
        {d && <List title="Career progression" items={d.prog} />}
        {d && <List title="Example projects" items={d.projects} />}
        {m && <List title="Related careers" items={m.related} />}
        <List title="Learning resources" items={res.map(r => `${r.title} (${r.type})`)} />
      </div>
    </div>
  )
}
