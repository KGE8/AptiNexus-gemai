import { useEffect, useMemo, useState } from 'react'
import { careerMeta, careers as fallbackCareers, type Career } from '../../data/careers'
import { byName } from '../../data/skills'
import { careersApi, matchingApi } from '../../services/api'
import type { CareerMatch } from '../../types'

const rank = { Beginner: 1, Intermediate: 2, Advanced: 3 }
const difficulty = (miss: string[]) => {
  if (!miss.length) return 'None'
  const a = miss.reduce((t, s) => t + rank[byName(s)?.difficulty ?? 'Intermediate'], 0) / miss.length
  return a < 1.7 ? 'Lower' : a < 2.4 ? 'Moderate' : 'Higher'
}

export default function CareerComparisonPage() {
  const [careers, setCareers] = useState<Career[]>(fallbackCareers)
  const [matches, setMatches] = useState<CareerMatch[]>([])
  const [sel, setSel] = useState<string[]>([fallbackCareers[0].id, fallbackCareers[1].id])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    Promise.all([careersApi.list(), matchingApi.recommendations()])
      .then(([catalog, m]) => {
        if (!active) return
        setCareers(catalog)
        setMatches(m)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  const matchById = useMemo(() => new Map(matches.map(m => [m.id, m])), [matches])
  const toggle = (id: string) => setSel(s => (s.includes(id) ? s.filter(x => x !== id) : s.length < 3 ? [...s, id] : s))
  const cols = careers.filter(c => sel.includes(c.id))

  const rows: [string, (c: Career) => React.ReactNode][] = [
    ['Category', c => c.category],
    [
      'Profile compatibility',
      c => {
        const comp = matchById.get(c.id)?.compatibility ?? 0
        return <span className="tabular-nums font-medium text-[#007AFF]">~{comp}%</span>
      },
    ],
    [
      'Required skills',
      c => {
        const matchedSet = new Set((matchById.get(c.id)?.matched ?? []).map(s => s.toLowerCase()))
        return (
          <ul className="space-y-1">
            {c.required.map(s => (
              <li key={s}>
                <span className={matchedSet.has(s.toLowerCase()) ? 'text-[#248a3d]' : 'text-[#b25000]'}>
                  {matchedSet.has(s.toLowerCase()) ? '✓ in profile' : '○ missing'}
                </span>
                : {s}
              </li>
            ))}
          </ul>
        )
      },
    ],
    [
      'Skills matched',
      c => {
        const matchedCount = matchById.get(c.id)?.matched?.length ?? 0
        return (
          <span className="tabular-nums">
            {matchedCount} of {c.required.length}
          </span>
        )
      },
    ],
    ['Education', c => careerMeta[c.id]?.education ?? 'B.E. / B.Tech in a relevant discipline'],
    [
      'Learning difficulty',
      c => {
        const missing = matchById.get(c.id)?.missing ?? c.required
        return difficulty(missing)
      },
    ],
    ['Specializations', c => careerMeta[c.id]?.specs.join(', ') ?? '—'],
    ['Related careers', c => careerMeta[c.id]?.related.join(', ') ?? '—'],
  ]

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <div>
        <h1 className="text-2xl font-semibold text-[#1d1d1f]">Career Comparison</h1>
        <p className="text-sm text-[#6e6e73]">
          Compare up to three careers side by side. Compatibility and missing skills are calculated live from your saved profile and SkillProof evidence.
        </p>
      </div>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Choose careers to compare">
        {careers.map(c => (
          <button
            key={c.id}
            aria-pressed={sel.includes(c.id)}
            disabled={!sel.includes(c.id) && sel.length >= 3}
            onClick={() => toggle(c.id)}
            className={`btn-ghost !py-1.5 ${sel.includes(c.id) ? 'bg-[#007AFF]/10 text-[#007AFF]' : ''}`}
          >
            {c.title}
          </button>
        ))}
      </div>
      {loading && <p className="glass p-4 text-sm text-[#6e6e73]">Calculating live comparison from your profile…</p>}
      {cols.length < 2 ? (
        <p className="glass p-6">Select at least two careers to compare.</p>
      ) : (
        <div className="glass overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead>
              <tr className="border-b border-black/[0.08]">
                <th className="p-3" />
                {cols.map(c => (
                  <th key={c.id} scope="col" className="p-3 text-[#1d1d1f]">
                    {c.title}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(([label, fn]) => (
                <tr key={label} className="border-b border-black/[0.08] align-top">
                  <th scope="row" className="p-3 font-normal text-[#6e6e73]">
                    {label}
                  </th>
                  {cols.map(c => (
                    <td key={c.id} className="p-3">
                      {fn(c)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
