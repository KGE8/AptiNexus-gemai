export type SkillStatus = 'Claimed' | 'Practised' | 'Demonstrated' | 'Verified'
export interface User { id: string; name: string; email: string; headline: string }
export interface Skill { id: string; name: string; category: string; level: number; status: SkillStatus }
export interface CareerMatch { id: string; title: string; category: string; compatibility: number; missing: string[] }
export interface ProgressPoint { month: string; skills: number; demonstrated: number }
export interface DashboardData { profileCompletion: number; skills: Skill[]; careers: CareerMatch[]; progress: ProgressPoint[] }

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

export interface ResumeSuggestion {
  id?: string
  section: string
  target: string | null
  text: string
  normalizedSkill?: string | null
  origin: 'explicit' | 'inferred'
  confidence?: 'high' | 'medium'
  rationale?: string
}

export interface ResumeAnalysis {
  filename: string
  extractedCharacters: number
  mode?: 'gemini' | 'fallback'
  suggestions: ResumeSuggestion[]
  profileCorrections?: ProfileCorrection[]
  message: string
}

export interface SkillMicroQuiz {
  id: string
  title: string
  skill: string
  mode: 'gemini' | 'fallback'
  quizToken: string
  questions: { q: string; options: string[] }[]
}

export interface SkillMicroQuizSubmission {
  assessmentId: string
  skill: string
  score: number
  total: number
  percentage: number
  correctAnswers: number[]
  explanations: string[]
  feedback: string
}
