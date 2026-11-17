import { request } from './client'
import { delay, mockDashboard, mockUser } from '../mock/data'
import type { AiRecommendationsResult, DashboardData, ResumeAnalysis, SkillMicroQuiz, SkillMicroQuizSubmission, User } from '../../types'

const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) })

export const authApi = {
  login: (email: string, password: string) =>
    request<{ user: User; token: string }>('/auth/login', post({ email, password }), () => delay({ user: { ...mockUser, email }, token: 'demo-token' })),
  register: (name: string, email: string, password: string) =>
    request<{ user: User; token: string }>('/auth/register', post({ name, email, password }), () => delay({ user: { ...mockUser, name, email }, token: 'demo-token' })),
}
export const analyticsApi = {
  dashboard: () => request<DashboardData>('/analytics/dashboard', undefined, () => delay(mockDashboard, 600)),
}

// ---- Per-user data (mock: localStorage; real: REST) ----
import { userData } from './userData'
import { careers } from '../../data/careers'
import { library } from '../../data/skills'
import { resources } from '../../data/resources'
import { assessments, type Assessment } from '../../data/assessments'
import { edges, nodes } from '../../data/graph'
import type { ProfileData } from '../../data/profile'

export const profilesApi = { get: (uid: string, init: ProfileData) => userData.get('profile', uid, init), save: (uid: string, p: ProfileData) => userData.save('profile', uid, p) }
export const roadmapApi = {
  progress: (uid: string | undefined, careerId: string) => userData.get<string[]>(`roadmap:${careerId}`, uid, []),
  totalDone: async (uid: string | undefined) => (await Promise.all(careers.map(c => userData.get<string[]>(`roadmap:${c.id}`, uid, [])))).reduce((n, l) => n + l.length, 0),
}
// ---- Catalogs ----
export const careersApi = { list: () => request('/careers', undefined, async () => careers), get: (id: string) => request(`/careers/${id}`, undefined, async () => careers.find(c => c.id === id)) }
export const skillsApi = { list: () => request('/skills', undefined, async () => library) }
export const resourcesApi = { list: () => request('/resources', undefined, async () => resources) }
export const assessmentsApi = {
  list: () => request<Assessment[]>('/assessments', undefined, async () => assessments),
  submit: (id: string, answers: number[]) => request<{ assessmentId: string; score: number; total: number; percentage: number; correctAnswers: number[]; feedback: string }>(`/assessments/${id}/submit`, post({ answers }), async () => {
    const item = assessments.find(a => a.id === id)
    if (!item) throw new Error('Assessment not found')
    const correctAnswers = item.questions.map(q => q.answer ?? -1)
    const score = answers.filter((answer, index) => answer === correctAnswers[index]).length
    const total = item.questions.length
    return { assessmentId: id, score, total, percentage: total ? Math.round(100 * score / total) : 0, correctAnswers, feedback: total && score / total >= 0.75 ? 'Strong result. Add a project or demonstration to back it up.' : total && score / total >= 0.5 ? 'Partial result. Revisit the topics you missed.' : 'This skill needs more practice.' }
  }),
}
export const skillGraphApi = { get: () => request('/skillgraph', undefined, async () => ({ nodes, edges })) }

// ---- Intelligence endpoints ----
import { delay as wait } from '../mock/data'
import { resumeSample } from '../mock/resume'
import { estimate, estimateFor, userSkills } from '../../data/careers'
import { analyse } from '../../data/skills'

export type { ResumeSuggestion, ResumeAnalysis } from '../../types'

export const aiApi = {
  recommendations: (payload?: { focusCareerId?: string; customGoal?: string }) =>
    request<AiRecommendationsResult>('/ai/recommendations', post(payload ?? {}), async () => {
      await wait(null, 500)
      return {
        mode: 'fallback',
        analyzedAt: new Date().toISOString(),
        summary: 'Demo fallback recommendations based on sample skills.',
        careerSuggestions: careers.slice(0, 4).map((c, idx) => ({
          careerId: c.id,
          title: c.title,
          category: c.category,
          compatibility: estimate(c),
          rationale: c.why,
          matchedSkills: c.required.filter(s => userSkills.includes(s)),
          bridgeSkills: c.required.filter(s => !userSkills.includes(s)).slice(0, 3),
          isAdjacentDiscovery: idx >= 2,
        })),
        courseRecommendations: resources.slice(0, 4).map((r, i) => ({
          id: `mock-course-${i}`,
          title: r.title,
          type: r.type,
          targetSkill: r.skill,
          level: r.level,
          reason: `Builds ${r.skill} toward your target careers.`,
          url: r.url,
        })),
        profileCorrections: [
          {
            id: 'mock-corr-1',
            action: 'add',
            section: 'technical',
            suggestedValue: 'ROS',
            rationale: 'Recommended next bridge skill connecting Python and Control Systems.',
          },
        ],
      }
    }),
  generateSkillQuiz: (skill: string) =>
    request<SkillMicroQuiz>('/ai/skill-quiz', post({ skill }), async () => {
      await wait(null, 500)
      return {
        id: `mock-quiz-${skill.toLowerCase()}`,
        title: `${skill} Claimed Skill Check`,
        skill,
        mode: 'fallback',
        quizToken: `mock:${skill}`,
        questions: [
          { q: `Which best describes a core concept in ${skill}?`, options: ['Systematic design and verification', 'Unstructured trial only', 'Ignoring edge cases', 'Skipping documentation'] },
          { q: `When applying ${skill} in a project, what makes it Demonstrated?`, options: ['A working artifact or linked code/CAD evidence', 'Listing the keyword only', 'Guessing parameters', 'Avoiding testing'] },
          { q: `What is the best first step when debugging an issue in ${skill}?`, options: ['Isolate variables and reproduce the issue', 'Rewrite everything blindly', 'Delete logs', 'Ignore warnings'] },
          { q: `How do you validate results produced using ${skill}?`, options: ['Compare against analytical or measured benchmarks', 'Assume first output is right', 'Skip boundary checks', 'Disable assertions'] },
        ],
      }
    }),
  submitSkillQuiz: (quizToken: string, answers: number[]) =>
    request<SkillMicroQuizSubmission>('/ai/skill-quiz/submit', post({ quizToken, answers }), async () => {
      await wait(null, 300)
      const skill = quizToken.replace(/^mock:/, '') || 'Skill'
      const correctAnswers = [0, 0, 0, 0]
      const score = answers.filter((a, i) => a === correctAnswers[i]).length
      const total = correctAnswers.length
      return {
        assessmentId: `mock-quiz-${skill.toLowerCase()}`,
        skill,
        score,
        total,
        percentage: Math.round((100 * score) / total),
        correctAnswers,
        explanations: [
          'Systematic design and verification are foundational.',
          'Working project artifacts upgrade a skill from Claimed to Demonstrated.',
          'Isolating variables and reproducing the failure is essential.',
          'Benchmarking outputs against analytical or measured references validates correctness.',
        ],
        feedback: score >= 3 ? 'Strong result. This counts as Practised evidence in SkillProof.' : 'Review the concepts and try again.',
      }
    }),
}

export const resumeApi = {
  analyse: (file: File) => {
    const body = new FormData()
    body.append('file', file)
    return request<ResumeAnalysis>('/resume/analyze', { method: 'POST', body }, async () => {
      await wait(null, 900)
      return {
        filename: file.name,
        extractedCharacters: 0,
        mode: 'fallback',
        suggestions: resumeSample.map((s, idx) => ({
          id: `mock-res-${idx}`,
          ...s,
          origin: s.origin as 'explicit' | 'inferred',
          confidence: s.origin === 'explicit' ? 'high' : 'medium',
        })),
        profileCorrections: [],
        message: 'Demo output only. Mock mode does not read the uploaded file.',
      }
    })
  },
}
export const matchingApi = { recommendations: () => request('/careers/matches', undefined, async () => careers.map(c => { const matched = c.required.filter(s => userSkills.includes(s)); return { id: c.id, title: c.title, category: c.category, compatibility: Math.round(100 * matched.length / c.required.length), matched, missing: c.required.filter(s => !userSkills.includes(s)) } }).sort((a, b) => b.compatibility - a.compatibility)) }
export const gapsApi = { analyse: (careerId: string) => request(`/careers/${careerId}/gaps`, undefined, async () => { const c = careers.find(x => x.id === careerId); return c ? analyse(c) : null }) }
export const whatIfApi = { simulate: (extraSkills: string[]) => request('/what-if', post({ extraSkills }), async () => careers.map(c => { const current = estimate(c); const hypothetical = estimateFor(c, [...userSkills, ...extraSkills]); return { id: c.id, current, hypothetical, change: hypothetical - current, stillNeeded: c.required.filter(s => !userSkills.includes(s) && !extraSkills.includes(s)) } })) }
