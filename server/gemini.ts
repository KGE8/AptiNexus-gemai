import crypto from 'node:crypto'
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai'
import { CAREERS, RESOURCES, SKILLS } from './catalogs.ts'
import {
  getFullUserSnapshot,
  userSkillNames,
  type ProfilePayload,
  type UserRecord,
} from './store.ts'

export interface CareerSuggestion {
  careerId: string
  title: string
  category: string
  compatibility: number
  rationale: string
  matchedSkills: string[]
  bridgeSkills: string[]
  isAdjacentDiscovery: boolean
}

export interface CourseRecommendation {
  id: string
  title: string
  type: 'Course' | 'Documentation' | 'Tutorial' | 'Video' | 'Book' | 'Practical project'
  targetSkill: string
  level: 'Beginner' | 'Intermediate' | 'Advanced'
  reason: string
  url?: string
}

export interface ProfileCorrection {
  id: string
  action: 'add' | 'normalize' | 'refine'
  section: string
  currentValue?: string
  suggestedValue: string
  rationale: string
}

export interface AiRecommendationsResult {
  mode: 'gemini' | 'fallback'
  analyzedAt: string
  summary: string
  notice?: string
  careerSuggestions: CareerSuggestion[]
  courseRecommendations: CourseRecommendation[]
  profileCorrections: ProfileCorrection[]
}

export interface SmartResumeSuggestion {
  id: string
  section: string
  target: string | null
  text: string
  normalizedSkill?: string | null
  origin: 'explicit' | 'inferred'
  confidence: 'high' | 'medium'
  rationale: string
}

export interface SmartResumeResult {
  filename: string
  extractedCharacters: number
  mode: 'gemini' | 'fallback'
  message: string
  suggestions: SmartResumeSuggestion[]
  profileCorrections: ProfileCorrection[]
}

const VALID_SECTIONS = new Set([
  'education',
  'subjects',
  'technical',
  'soft',
  'interests',
  'experience',
  'projects',
  'certifications',
  'achievements',
  'goals',
  'name',
  'headline',
  'location',
])

const VALID_RESOURCE_TYPES = new Set([
  'Course',
  'Documentation',
  'Tutorial',
  'Video',
  'Book',
  'Practical project',
])

function getClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY?.trim()
  if (!apiKey) return null
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  })
}

function safeHttpUrl(url?: string | null): string | undefined {
  if (!url) return undefined
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? url : undefined
  } catch {
    return undefined
  }
}

export class GeminiUpstreamError extends Error {
  status: number
  constructor(message: string, status = 502) {
    super(message)
    this.status = status
  }
}

function formatGeminiError(error: unknown): GeminiUpstreamError {
  if (error instanceof GeminiUpstreamError) return error
  const raw = error instanceof Error ? error.message : String(error)
  if (/PERMISSION_DENIED|API_KEY_INVALID|403|400/.test(raw)) {
    return new GeminiUpstreamError(
      'Gemini API request could not be authorized. Check your server API key in Settings > Secrets.',
      403,
    )
  }
  if (/RESOURCE_EXHAUSTED|429/.test(raw)) {
    return new GeminiUpstreamError('Gemini API rate limit reached. Wait a moment and retry.', 429)
  }
  if (/503|UNAVAILABLE|high demand|temporarily/i.test(raw)) {
    return new GeminiUpstreamError(
      'Gemini model is temporarily experiencing high demand (503). Please retry in a few seconds.',
      503,
    )
  }
  if (/abort|timed out|timeout/i.test(raw)) {
    return new GeminiUpstreamError('Gemini API request timed out. Please try again.', 504)
  }
  return new GeminiUpstreamError(`Gemini analysis failed: ${raw}`, 502)
}

async function withTimeout<T>(promise: Promise<T>, ms = 45000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Gemini request timed out')), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function isTransientError(error: unknown): boolean {
  const raw = error instanceof Error ? error.message : String(error)
  return /503|UNAVAILABLE|high demand|temporarily|429|RESOURCE_EXHAUSTED/i.test(raw)
}

async function callGeminiWithRetry<T>(fn: () => Promise<T>): Promise<T> {
  const delays = [0, 800, 1600]
  let lastErr: unknown
  for (let i = 0; i < delays.length; i++) {
    if (delays[i] > 0) await new Promise(r => setTimeout(r, delays[i]))
    try {
      return await withTimeout(fn(), 45000)
    } catch (err) {
      lastErr = err
      if (!isTransientError(err)) throw err
    }
  }
  throw lastErr
}

export async function generateAiRecommendations(
  user: UserRecord,
  options?: { focusCareerId?: string; customGoal?: string },
): Promise<AiRecommendationsResult> {
  const ai = getClient()
  if (!ai) {
    throw new GeminiUpstreamError(
      'Gemini API key is not configured on the server. Add GEMINI_API_KEY in Settings > Secrets.',
      503,
    )
  }

  const snapshot = getFullUserSnapshot(user)
  const acquired = Array.from(userSkillNames(user))

  const promptPayload = {
    userProfile: snapshot.profile,
    userProjects: snapshot.projects,
    userEvidence: snapshot.evidence,
    assessmentResults: snapshot.results,
    userSettings: snapshot.settings,
    derivedSkills: acquired,
    focusCareerId: options?.focusCareerId ?? null,
    customGoal: options?.customGoal ?? null,
    catalogCareers: CAREERS.map(c => ({ id: c.id, title: c.title, category: c.category, required: c.required })),
    catalogSkills: SKILLS.map(s => s.name),
    catalogResources: RESOURCES.map(r => ({ title: r.title, type: r.type, skill: r.skill, level: r.level, url: r.url })),
  }

  try {
    const response = await callGeminiWithRetry(() =>
      ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: `Analyze this student's full database state and recommend personalized career targets, tailored courses/learning resources, and profile corrections.\n\n${JSON.stringify(promptPayload)}`,
      config: {
        systemInstruction:
          'You are the AptiNexus Career & Skill Intelligence Engine. Scan the user profile, projects, evidence, and assessment results against the provided career, skill, and resource catalogs. ' +
          'Infer transferable strengths, highlight adjacent/unexpected career opportunities aligned with their interests and abilities, prioritize courses/resources that bridge specific gaps, and propose concrete profile corrections (normalizing informal skill names to canonical catalogSkills names, surfacing skills implied by projects/experience, or refining vague goals/headlines). ' +
          'Return 4-5 careerSuggestions, 4-5 courseRecommendations, and up to 4 profileCorrections. Keep summary and each rationale to 1 crisp sentence, NEVER assign Verified status, and only include URLs present verbatim in catalogResources.',
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            summary: { type: Type.STRING },
            careerSuggestions: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  careerId: { type: Type.STRING },
                  title: { type: Type.STRING },
                  category: { type: Type.STRING },
                  compatibility: { type: Type.INTEGER },
                  rationale: { type: Type.STRING },
                  matchedSkills: { type: Type.ARRAY, items: { type: Type.STRING } },
                  bridgeSkills: { type: Type.ARRAY, items: { type: Type.STRING } },
                  isAdjacentDiscovery: { type: Type.BOOLEAN },
                },
                required: ['careerId', 'title', 'category', 'compatibility', 'rationale', 'matchedSkills', 'bridgeSkills', 'isAdjacentDiscovery'],
              },
            },
            courseRecommendations: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  title: { type: Type.STRING },
                  type: { type: Type.STRING },
                  targetSkill: { type: Type.STRING },
                  level: { type: Type.STRING },
                  reason: { type: Type.STRING },
                  url: { type: Type.STRING },
                },
                required: ['title', 'type', 'targetSkill', 'level', 'reason'],
              },
            },
            profileCorrections: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  action: { type: Type.STRING },
                  section: { type: Type.STRING },
                  currentValue: { type: Type.STRING },
                  suggestedValue: { type: Type.STRING },
                  rationale: { type: Type.STRING },
                },
                required: ['action', 'section', 'suggestedValue', 'rationale'],
              },
            },
          },
          required: ['summary', 'careerSuggestions', 'courseRecommendations', 'profileCorrections'],
        },
      },
    }))

    const raw = JSON.parse((response.text ?? '{}').trim()) as {
      summary?: string
      careerSuggestions?: Array<Partial<CareerSuggestion>>
      courseRecommendations?: Array<Partial<CourseRecommendation>>
      profileCorrections?: Array<Partial<ProfileCorrection>>
    }

    const catalogCareerIds = new Set(CAREERS.map(c => c.id))
    const catalogUrlByTitle = new Map(RESOURCES.filter(r => r.url).map(r => [r.title.toLowerCase(), r.url!]))
    const existingTechnical = new Set((snapshot.profile.sections.technical ?? []).map(s => s.toLowerCase()))

    const careerSuggestions: CareerSuggestion[] = (raw.careerSuggestions ?? [])
      .filter(c => c.title && c.rationale)
      .slice(0, 6)
      .map((c, idx) => ({
        careerId: c.careerId && catalogCareerIds.has(c.careerId) ? c.careerId : CAREERS[0].id,
        title: String(c.title),
        category: String(c.category || 'Engineering'),
        compatibility: Math.max(0, Math.min(100, Math.round(Number(c.compatibility ?? 50)))),
        rationale: String(c.rationale),
        matchedSkills: Array.isArray(c.matchedSkills) ? c.matchedSkills.map(String) : [],
        bridgeSkills: Array.isArray(c.bridgeSkills) ? c.bridgeSkills.map(String) : [],
        isAdjacentDiscovery: Boolean(c.isAdjacentDiscovery ?? idx >= 2),
      }))

    const courseRecommendations: CourseRecommendation[] = (raw.courseRecommendations ?? [])
      .filter(r => r.title && r.targetSkill && r.reason)
      .slice(0, 6)
      .map((r, idx) => {
        const typeStr = String(r.type || 'Course')
        const validType = VALID_RESOURCE_TYPES.has(typeStr)
          ? (typeStr as CourseRecommendation['type'])
          : 'Course'
        const levelStr = String(r.level || 'Intermediate')
        const validLevel =
          levelStr === 'Beginner' || levelStr === 'Intermediate' || levelStr === 'Advanced'
            ? levelStr
            : 'Intermediate'
        const matchedUrl = catalogUrlByTitle.get(String(r.title).toLowerCase()) ?? safeHttpUrl(r.url)
        return {
          id: `ai-course-${idx}`,
          title: String(r.title),
          type: validType,
          targetSkill: String(r.targetSkill),
          level: validLevel,
          reason: String(r.reason),
          url: matchedUrl,
        }
      })

    const profileCorrections: ProfileCorrection[] = (raw.profileCorrections ?? [])
      .filter(p => p.suggestedValue && p.rationale && p.section && VALID_SECTIONS.has(p.section))
      .filter(p => !(p.action === 'add' && p.section === 'technical' && existingTechnical.has(String(p.suggestedValue).toLowerCase())))
      .slice(0, 6)
      .map((p, idx) => {
        const action = p.action === 'normalize' || p.action === 'refine' ? p.action : 'add'
        return {
          id: `ai-corr-${idx}-${String(p.section)}`,
          action,
          section: String(p.section),
          currentValue: p.currentValue ? String(p.currentValue) : undefined,
          suggestedValue: String(p.suggestedValue),
          rationale: String(p.rationale),
        }
      })

    return {
      mode: 'gemini',
      analyzedAt: new Date().toISOString(),
      summary: String(raw.summary || 'Dynamic analysis generated from your saved profile, projects, and interests.'),
      careerSuggestions,
      courseRecommendations,
      profileCorrections,
    }
  } catch (error) {
    throw formatGeminiError(error)
  }
}

export async function analyzeResumeWithGemini(
  text: string,
  filename: string,
  existingProfile: ProfilePayload,
): Promise<SmartResumeResult> {
  const ai = getClient()
  if (!ai) {
    throw new GeminiUpstreamError(
      'Gemini API key is not configured on the server. Add GEMINI_API_KEY in Settings > Secrets.',
      503,
    )
  }

  const snippet = text.slice(0, 14000)

  try {
    const response = await callGeminiWithRetry(() => ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: `Analyze this uploaded resume text alongside the user's current saved profile and canonical skills catalog.\n\nResume filename: ${filename}\nResume text:\n${snippet}\n\nExisting saved profile:\n${JSON.stringify(existingProfile)}\n\nCanonical catalog skills:\n${JSON.stringify(SKILLS.map(s => s.name))}`,
      config: {
        systemInstruction:
          'You are the AptiNexus Resume Intelligence parser. Extract structured profile items from the resume into valid sections (education, subjects, technical, soft, interests, experience, projects, certifications, achievements, goals). ' +
          'Tag each item origin as "explicit" if directly written in the resume, or "inferred" if reasonably deduced from a project/experience description. ' +
          'Also compare the resume against existingProfile to generate profileCorrections: add missing canonical skills, normalize non-standard wording to canonical catalog skill names, or update personal fields (section "name", "headline", or "location") if the resume contains a fuller name, stronger headline, or city/location missing from existingProfile.personal. ' +
          'Be conservative, never invent credentials, and never claim Verified status.',
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            message: { type: Type.STRING },
            suggestions: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  section: { type: Type.STRING },
                  target: { type: Type.STRING },
                  text: { type: Type.STRING },
                  normalizedSkill: { type: Type.STRING },
                  origin: { type: Type.STRING },
                  confidence: { type: Type.STRING },
                  rationale: { type: Type.STRING },
                },
                required: ['section', 'target', 'text', 'origin', 'confidence', 'rationale'],
              },
            },
            profileCorrections: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  action: { type: Type.STRING },
                  section: { type: Type.STRING },
                  currentValue: { type: Type.STRING },
                  suggestedValue: { type: Type.STRING },
                  rationale: { type: Type.STRING },
                },
                required: ['action', 'section', 'suggestedValue', 'rationale'],
              },
            },
          },
          required: ['message', 'suggestions', 'profileCorrections'],
        },
      },
    }))

    const raw = JSON.parse((response.text ?? '{}').trim()) as {
      message?: string
      suggestions?: Array<Partial<SmartResumeSuggestion>>
      profileCorrections?: Array<Partial<ProfileCorrection>>
    }

    const suggestions: SmartResumeSuggestion[] = (raw.suggestions ?? [])
      .filter(s => s.text && s.target && VALID_SECTIONS.has(s.target))
      .slice(0, 40)
      .map((s, idx) => ({
        id: `resume-ai-${idx}`,
        section: String(s.section || s.target),
        target: s.target && VALID_SECTIONS.has(s.target) ? s.target : null,
        text: String(s.text).slice(0, 240),
        normalizedSkill: s.normalizedSkill ? String(s.normalizedSkill) : undefined,
        origin: s.origin === 'inferred' ? 'inferred' : 'explicit',
        confidence: s.confidence === 'medium' ? 'medium' : 'high',
        rationale: String(s.rationale || 'Extracted from uploaded resume.'),
      }))

    const profileCorrections: ProfileCorrection[] = (raw.profileCorrections ?? [])
      .filter(p => p.suggestedValue && p.rationale && p.section && VALID_SECTIONS.has(p.section))
      .slice(0, 8)
      .map((p, idx) => ({
        id: `resume-corr-${idx}`,
        action: p.action === 'normalize' || p.action === 'refine' ? p.action : 'add',
        section: String(p.section),
        currentValue: p.currentValue ? String(p.currentValue) : undefined,
        suggestedValue: String(p.suggestedValue),
        rationale: String(p.rationale),
      }))

    return {
      filename,
      extractedCharacters: text.length,
      mode: 'gemini',
      message: String(
        raw.message ||
          'Gemini extracted structured items and profile normalization suggestions. Review and accept items to save them to your profile; no credential is independently verified.',
      ),
      suggestions,
      profileCorrections,
    }
  } catch (error) {
    throw formatGeminiError(error)
  }
}

export interface SkillMicroQuizResponse {
  id: string
  title: string
  skill: string
  mode: 'gemini' | 'fallback'
  quizToken: string
  questions: { q: string; options: string[] }[]
}

export interface SkillMicroQuizGrade {
  assessmentId: string
  skill: string
  score: number
  total: number
  percentage: number
  correctAnswers: number[]
  explanations: string[]
  feedback: string
}

const QUIZ_SECRET = process.env.SECRET_KEY || 'aptinexus-preview-secret-change-in-production'

function signQuizToken(payload: { id: string; skill: string; answers: number[]; explanations: string[] }): string {
  const encoded = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + 1000 * 60 * 60 * 4 })).toString('base64url')
  const sig = crypto.createHmac('sha256', QUIZ_SECRET).update(encoded).digest('base64url')
  return `${encoded}.${sig}`
}

function verifyQuizToken(token: string): { id: string; skill: string; answers: number[]; explanations: string[] } | null {
  const [encoded, sig] = token.split('.')
  if (!encoded || !sig) return null
  const expected = crypto.createHmac('sha256', QUIZ_SECRET).update(encoded).digest('base64url')
  const sigBuf = Buffer.from(sig)
  const expBuf = Buffer.from(expected)
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as {
      id?: string
      skill?: string
      answers?: number[]
      explanations?: string[]
      exp?: number
    }
    if (!parsed.id || !parsed.skill || !Array.isArray(parsed.answers) || !parsed.exp || parsed.exp < Date.now()) {
      return null
    }
    return {
      id: parsed.id,
      skill: parsed.skill,
      answers: parsed.answers,
      explanations: Array.isArray(parsed.explanations) ? parsed.explanations : [],
    }
  } catch {
    return null
  }
}

export async function generateSkillMicroQuiz(user: UserRecord, skillName: string): Promise<SkillMicroQuizResponse> {
  const cleanSkill = skillName.trim().slice(0, 80)
  if (!cleanSkill) {
    throw new GeminiUpstreamError('Skill name is required.', 422)
  }

  const ai = getClient()
  if (!ai) {
    throw new GeminiUpstreamError(
      'Gemini API key is not configured on the server. Add GEMINI_API_KEY in Settings > Secrets.',
      503,
    )
  }

  const snapshot = getFullUserSnapshot(user)
  const catalogSkill = SKILLS.find(s => s.name.toLowerCase() === cleanSkill.toLowerCase())

  try {
    const response = await callGeminiWithRetry(() =>
      ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents:
          `Generate a 4-question multiple-choice technical micro-assessment to verify practical understanding of the claimed skill "${cleanSkill}".\n\n` +
          `Catalog skill metadata: ${JSON.stringify(catalogSkill ?? { name: cleanSkill })}\n` +
          `Student profile context (projects & experience): ${JSON.stringify({
            headline: snapshot.profile.personal.headline,
            projects: snapshot.profile.sections.projects ?? [],
            experience: snapshot.profile.sections.experience ?? [],
          })}`,
        config: {
          systemInstruction:
            'You are the AptiNexus Claimed-Skill Verification Engine. Create exactly 4 practical, scenario-based multiple-choice questions for the requested skill. ' +
            'Each question must have exactly 4 concise options, a 0-based correctIndex (0, 1, 2, or 3), and a 1-sentence explanation. ' +
            'Questions should test real engineering/practical comprehension rather than trivia.',
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              title: { type: Type.STRING },
              questions: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    q: { type: Type.STRING },
                    options: { type: Type.ARRAY, items: { type: Type.STRING } },
                    correctIndex: { type: Type.INTEGER },
                    explanation: { type: Type.STRING },
                  },
                  required: ['q', 'options', 'correctIndex', 'explanation'],
                },
              },
            },
            required: ['title', 'questions'],
          },
        },
      }),
    )

    const raw = JSON.parse((response.text ?? '{}').trim()) as {
      title?: string
      questions?: Array<{ q?: string; options?: string[]; correctIndex?: number; explanation?: string }>
    }

    const validQuestions = (raw.questions ?? [])
      .filter(q => q.q && Array.isArray(q.options) && q.options.length >= 2)
      .slice(0, 4)
      .map(q => {
        const opts = q.options!.slice(0, 4).map(String)
        while (opts.length < 4) opts.push(`Option ${opts.length + 1}`)
        const idx = Math.max(0, Math.min(opts.length - 1, Math.round(Number(q.correctIndex ?? 0))))
        return {
          q: String(q.q),
          options: opts,
          correctIndex: idx,
          explanation: String(q.explanation || 'Review the core principles for this skill.'),
        }
      })

    if (validQuestions.length === 0) {
      throw new Error('Gemini returned an empty question set.')
    }

    const id = `ai-quiz-${Date.now().toString(36)}`
    const quizToken = signQuizToken({
      id,
      skill: cleanSkill,
      answers: validQuestions.map(q => q.correctIndex),
      explanations: validQuestions.map(q => q.explanation),
    })

    return {
      id,
      title: String(raw.title || `${cleanSkill} — Claimed Skill Check`),
      skill: cleanSkill,
      mode: 'gemini',
      quizToken,
      questions: validQuestions.map(q => ({ q: q.q, options: q.options })),
    }
  } catch (error) {
    throw formatGeminiError(error)
  }
}

export function gradeSkillMicroQuiz(quizToken: string, answers: number[]): SkillMicroQuizGrade | { error: string; status: number } {
  const verified = verifyQuizToken(quizToken)
  if (!verified) {
    return { error: 'Invalid or expired quiz session. Generate a new quiz.', status: 422 }
  }
  if (!Array.isArray(answers) || answers.length !== verified.answers.length) {
    return { error: 'Submit one answer for every question.', status: 422 }
  }
  const invalid = answers.some(a => typeof a !== 'number' || !Number.isInteger(a) || a < 0 || a > 3)
  if (invalid) {
    return { error: 'One or more answers are out of range.', status: 422 }
  }

  const score = answers.filter((a, idx) => a === verified.answers[idx]).length
  const total = verified.answers.length
  const ratio = total ? score / total : 0
  return {
    assessmentId: verified.id,
    skill: verified.skill,
    score,
    total,
    percentage: total ? Math.round((100 * score) / total) : 0,
    correctAnswers: verified.answers,
    explanations: verified.explanations,
    feedback:
      ratio >= 0.75
        ? `Strong result (${score}/${total}). Recorded as Practised evidence for ${verified.skill} in SkillProof.`
        : ratio >= 0.5
          ? `Partial result (${score}/${total}). Score 70% or higher to record Practised evidence in SkillProof.`
          : `Keep practising ${verified.skill} and try another micro-quiz when ready.`,
  }
}
