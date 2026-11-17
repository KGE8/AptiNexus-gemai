import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Sparkles } from 'lucide-react'
import { useToast } from '../../contexts/ToastContext'
import { useAuth } from '../../contexts/AuthContext'
import { aiApi, assessmentsApi } from '../../services/api'
import type { Assessment } from '../../data/assessments'
import type { Result } from '../../data/evidence'
import { loadProfile, type ProfileData } from '../../data/profile'
import { library } from '../../data/skills'
import { useRemote } from '../../hooks/useRemote'
import type { User } from '../../types'

interface ActiveQuiz {
  id: string
  title: string
  skill: string
  questions: { q: string; options: string[] }[]
  quizToken?: string
}

export default function AssessmentPage() {
  const user = useAuth().user as User
  const uid = user?.id
  const toast = useToast()
  const [searchParams, setSearchParams] = useSearchParams()
  const [profile] = useRemote<ProfileData>('profile', uid, loadProfile(user))
  const [res, setRes] = useRemote<Result[]>('results', uid, [])
  const [assessments, setAssessments] = useState<Assessment[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  const [selectedSkill, setSelectedSkill] = useState(() => searchParams.get('skill') || '')
  const [generating, setGenerating] = useState(false)
  const [genError, setGenError] = useState('')

  const [a, setA] = useState<ActiveQuiz | null>(null)
  const [i, setI] = useState(0)
  const [ans, setAns] = useState<number[]>([])
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)
  const [score, setScore] = useState(0)
  const [reviewAnswers, setReviewAnswers] = useState<number[]>([])
  const [explanations, setExplanations] = useState<string[]>([])
  const [note, setNote] = useState('')

  const claimedSkills = useMemo(() => {
    const fromProfile = profile.sections?.technical ?? []
    const unique = new Set<string>(fromProfile.filter(Boolean))
    if (unique.size === 0) {
      for (const s of ['Python', 'CAD Design', 'Embedded C', 'Control Systems']) unique.add(s)
    }
    return Array.from(unique)
  }, [profile.sections?.technical])

  useEffect(() => {
    if (!selectedSkill && claimedSkills.length > 0) {
      setSelectedSkill(claimedSkills[0])
    }
  }, [claimedSkills, selectedSkill])

  useEffect(() => {
    let active = true
    assessmentsApi
      .list()
      .then(items => {
        if (active) setAssessments(items)
      })
      .catch(error => {
        if (active) setLoadError(error instanceof Error ? error.message : 'Could not load assessments.')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  const begin = (x: ActiveQuiz) => {
    setA(x)
    setI(0)
    setAns(Array(x.questions.length).fill(-1))
    setDone(false)
    setScore(0)
    setReviewAnswers([])
    setExplanations([])
    setNote('')
  }

  const handleGenerateAiQuiz = async (skillOverride?: string) => {
    const target = (skillOverride ?? selectedSkill).trim()
    if (!target || generating) return
    setSelectedSkill(target)
    setGenerating(true)
    setGenError('')
    try {
      const quiz = await aiApi.generateSkillQuiz(target)
      if (searchParams.has('skill')) {
        setSearchParams({}, { replace: true })
      }
      begin({
        id: quiz.id,
        title: quiz.title,
        skill: quiz.skill,
        questions: quiz.questions,
        quizToken: quiz.quizToken,
      })
    } catch (error) {
      setGenError(error instanceof Error ? error.message : 'Could not generate Gemini micro-quiz right now.')
    } finally {
      setGenerating(false)
    }
  }

  const submit = async () => {
    if (!a || busy) return
    setBusy(true)
    try {
      if (a.quizToken) {
        const result = await aiApi.submitSkillQuiz(a.quizToken, ans)
        setScore(result.score)
        setReviewAnswers(result.correctAnswers)
        setExplanations(result.explanations ?? [])
        setNote(result.feedback)
        setDone(true)
        setRes([
          ...res,
          {
            id: Date.now().toString(36),
            assessment: a.title,
            skill: a.skill,
            score: result.score,
            total: result.total,
            date: new Date().toLocaleDateString(),
          },
        ])
      } else {
        const result = await assessmentsApi.submit(a.id, ans)
        setScore(result.score)
        setReviewAnswers(result.correctAnswers)
        setExplanations([])
        setNote(result.feedback)
        setDone(true)
        setRes([
          ...res,
          {
            id: Date.now().toString(36),
            assessment: a.title,
            skill: a.skill,
            score: result.score,
            total: result.total,
            date: new Date().toLocaleDateString(),
          },
        ])
      }
      toast.push('Quiz submitted')
    } catch (error) {
      toast.push(error instanceof Error ? error.message : 'Could not submit assessment.', 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div>
        <h1 className="text-2xl font-semibold text-[#1d1d1f]">Assessment Centre</h1>
        <p className="text-sm text-[#6e6e73]">
          Generate small-scale Gemini micro-tests for any claimed skill in your profile, or take a standard practice quiz. Scoring 70% or higher upgrades a skill to Practised in SkillProof.
        </p>
      </div>

      {!a && (
        <>
          <section className="glass space-y-4 p-5" aria-label="Gemini Claimed-Skill Micro-Test">
            <div className="flex items-center gap-2">
              <Sparkles size={17} className="text-[#007AFF]" aria-hidden />
              <h2 className="text-lg font-semibold text-[#1d1d1f]">Gemini Micro-Test for Claimed Skills</h2>
            </div>
            <p className="text-sm text-[#6e6e73]">
              Pick any claimed skill from your profile (or enter a skill from the catalog) to generate a tailored 4-question scenario check scored server-side.
            </p>

            {claimedSkills.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs text-[#6e6e73]">Your claimed profile skills:</p>
                <div className="flex flex-wrap gap-2">
                  {claimedSkills.map(skill => {
                    const passed = res.some(r => r.skill.toLowerCase() === skill.toLowerCase() && r.total > 0 && r.score / r.total >= 0.7)
                    return (
                      <button
                        key={skill}
                        type="button"
                        disabled={generating}
                        onClick={() => void handleGenerateAiQuiz(skill)}
                        className={`btn-ghost !py-1.5 !px-3 text-xs whitespace-nowrap ${
                          selectedSkill === skill ? 'border-[#007AFF]/40 bg-[#007AFF]/10 text-[#0062cc]' : ''
                        }`}
                      >
                        {skill} {passed ? '· Practised' : '· Test skill'}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            <form
              className="flex flex-col gap-2 sm:flex-row"
              onSubmit={e => {
                e.preventDefault()
                void handleGenerateAiQuiz()
              }}
            >
              <input
                list="catalog-skills-list"
                className="input flex-1"
                placeholder="Enter or select a skill to test (e.g. CAD Design, ROS, Control Systems)"
                aria-label="Skill to test with Gemini"
                value={selectedSkill}
                onChange={e => setSelectedSkill(e.target.value)}
              />
              <datalist id="catalog-skills-list">
                {library.map(s => (
                  <option key={s.name} value={s.name} />
                ))}
              </datalist>
              <button
                type="submit"
                disabled={generating || !selectedSkill.trim()}
                className="btn-primary whitespace-nowrap shrink-0"
              >
                <Sparkles size={15} />
                {generating ? 'Generating quiz…' : 'Generate micro-test'}
              </button>
            </form>

            {genError && (
              <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[#d70015]/25 bg-[#d70015]/5 p-3 text-sm text-[#d70015]">
                <span>{genError}</span>
                <button type="button" className="btn-ghost !py-1 text-xs" onClick={() => void handleGenerateAiQuiz()}>
                  Retry
                </button>
              </div>
            )}
          </section>

          <section className="space-y-3">
            <h2 className="font-medium text-[#1d1d1f]">Standard catalog quizzes</h2>
            {loading && <div className="glass p-4 text-sm text-[#6e6e73]">Loading assessments…</div>}
            {loadError && <p role="alert" className="text-sm text-[#d70015]">{loadError}</p>}
            <div className="grid gap-3 sm:grid-cols-3">
              {assessments.map(x => (
                <button key={x.id} className="glass p-4 text-left hover:bg-white/90" onClick={() => begin(x)}>
                  <p className="font-medium text-[#1d1d1f]">{x.title}</p>
                  <p className="text-xs text-[#6e6e73]">{x.skill} · {x.questions.length} questions</p>
                </button>
              ))}
            </div>
          </section>

          <section className="glass p-5">
            <h2 className="mb-2 font-medium text-[#1d1d1f]">Your results</h2>
            {res.length === 0 ? (
              <p className="text-sm text-[#6e6e73]">No attempts yet. Generate a micro-test or pick a quiz to start.</p>
            ) : (
              <ul className="space-y-1.5 text-sm">
                {res.map(r => (
                  <li key={r.id} className="flex items-center justify-between border-b border-black/[0.05] pb-1 last:border-none">
                    <span>{r.assessment} ({r.skill})</span>
                    <span className="tabular-nums text-[#6e6e73]">{r.score}/{r.total} · {r.date}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      {a && !done && (
        <section className="glass p-6">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium text-[#1d1d1f]">{a.title}</p>
            <p className="tabular-nums text-xs text-[#6e6e73]">Question {i + 1} of {a.questions.length}</p>
          </div>
          <div className="mt-2 h-1.5 rounded-full bg-black/[0.05]" role="progressbar" aria-valuenow={i + 1} aria-valuemin={1} aria-valuemax={a.questions.length}>
            <div className="h-1.5 rounded-full bg-nexus-cyan" style={{ width: `${((i + 1) / a.questions.length) * 100}%` }} />
          </div>
          <fieldset className="mt-4">
            <legend className="text-[#1d1d1f]">{a.questions[i].q}</legend>
            <div className="mt-3 space-y-2">
              {a.questions[i].options.map((o, n) => (
                <label
                  key={`${i}-${n}`}
                  className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
                    ans[i] === n ? 'border-[#007AFF] bg-[#007AFF]/10' : 'border-black/[0.08]'
                  }`}
                >
                  <input type="radio" name="opt" checked={ans[i] === n} onChange={() => setAns(ans.map((v, k) => (k === i ? n : v)))} />
                  {o}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="mt-5 flex justify-between">
            <div className="flex gap-2">
              <button className="btn-ghost" onClick={() => setA(null)} disabled={busy}>
                Cancel
              </button>
              <button className="btn-ghost" disabled={i === 0 || busy} onClick={() => setI(i - 1)}>
                Previous
              </button>
            </div>
            {i < a.questions.length - 1 ? (
              <button className="btn-primary" onClick={() => setI(i + 1)}>
                Next
              </button>
            ) : (
              <button className="btn-primary" disabled={ans.includes(-1) || busy} onClick={submit}>
                {busy ? 'Submitting…' : 'Submit answers'}
              </button>
            )}
          </div>
          {i === a.questions.length - 1 && ans.includes(-1) && (
            <p className="mt-2 text-xs text-[#6e6e73]">Answer every question to submit.</p>
          )}
        </section>
      )}

      {a && done && (
        <section className="glass space-y-3 p-6">
          <h2 className="tabular-nums text-xl font-semibold text-[#1d1d1f]">{score} / {a.questions.length}</h2>
          <p className="text-sm text-[#1d1d1f]">{a.skill}: {note}</p>
          <ul className="space-y-2.5 text-sm">
            {a.questions.map((q, n) => (
              <li key={q.q} className="rounded-lg border border-black/[0.06] bg-white/50 p-3">
                <div>
                  <span className={ans[n] === reviewAnswers[n] ? 'font-medium text-[#248a3d]' : 'font-medium text-[#d70015]'}>
                    {ans[n] === reviewAnswers[n] ? 'Correct' : 'Incorrect'}
                  </span>{' '}
                  · {q.q}
                </div>
                {ans[n] !== reviewAnswers[n] && (
                  <p className="mt-1 text-xs text-[#1d1d1f]">Correct answer: {q.options[reviewAnswers[n]]}</p>
                )}
                {explanations[n] && <p className="mt-1 text-xs text-[#6e6e73]">{explanations[n]}</p>}
              </li>
            ))}
          </ul>
          <p className="text-xs text-[#6e6e73]">A score of 70% or more counts as Practised evidence in SkillProof.</p>
          <button className="btn-primary" onClick={() => setA(null)}>
            Back to assessments
          </button>
        </section>
      )}
    </div>
  )
}
