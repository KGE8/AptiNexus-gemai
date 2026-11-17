import path from 'node:path'
import { fileURLToPath } from 'node:url'
try {
  process.loadEnvFile?.('.env')
} catch {
  // .env is optional when environment variables are injected by the host
}
import express, { type NextFunction, type Request, type Response } from 'express'
import multer from 'multer'
import mammoth from 'mammoth'
import { extractText, getDocumentProxy } from 'unpdf'
import { ASSESSMENTS, CAREERS, RESOURCES, SKILLS } from './server/catalogs.ts'
import {
  analyzeResumeWithGemini,
  GeminiUpstreamError,
  generateAiRecommendations,
  generateSkillMicroQuiz,
  gradeSkillMicroQuiz,
} from './server/gemini.ts'
import {
  buildSkillGraph,
  careerGaps,
  createAccessToken,
  createUser,
  dashboardData,
  decodeAccessToken,
  defaultProfileFor,
  findUserByEmail,
  findUserById,
  publicUser,
  readUserValue,
  simulateCareerMatches,
  verifyPassword,
  writeUserValue,
  type ProfilePayload,
  type UserRecord,
} from './server/store.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT || 3000)
const IS_PROD = process.env.NODE_ENV === 'production'

const app = express()
app.use(express.json({ limit: '2mb' }))

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
})

interface AuthedRequest extends Request {
  user?: UserRecord
}

function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ detail: 'Authentication required' })
    return
  }
  const token = header.slice(7).trim()
  const userId = decodeAccessToken(token)
  if (!userId) {
    res.status(401).json({ detail: 'Invalid or expired token' })
    return
  }
  const user = findUserById(userId)
  if (!user) {
    res.status(401).json({ detail: 'User no longer exists' })
    return
  }
  req.user = user
  next()
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'aptinexus-api' })
})

const api = express.Router()

api.post('/auth/register', (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : ''
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : ''
  const password = typeof req.body?.password === 'string' ? req.body.password : ''

  if (name.length < 1 || name.length > 120) {
    res.status(422).json({ detail: 'Enter your name' })
    return
  }
  if (email.length < 3 || !email.includes('@')) {
    res.status(422).json({ detail: 'Enter a valid email address' })
    return
  }
  if (password.length < 8) {
    res.status(422).json({ detail: 'Use at least 8 characters for your password' })
    return
  }
  if (findUserByEmail(email)) {
    res.status(409).json({ detail: 'An account with this email already exists' })
    return
  }
  const user = createUser(name, email, password)
  res.status(201).json({ user: publicUser(user), token: createAccessToken(user.id) })
})

api.post('/auth/login', (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : ''
  const password = typeof req.body?.password === 'string' ? req.body.password : ''
  const user = findUserByEmail(email)
  if (!user || !verifyPassword(password, user.passwordHash)) {
    res.status(401).json({ detail: 'Incorrect email or password' })
    return
  }
  res.json({ user: publicUser(user), token: createAccessToken(user.id) })
})

// ---- Per-user persisted resources ----
api.get('/profiles/me', requireAuth, (req: AuthedRequest, res) => {
  const user = req.user!
  res.json(readUserValue(user.id, 'profile', defaultProfileFor(user)))
})

api.put('/profiles/me', requireAuth, (req: AuthedRequest, res) => {
  const user = req.user!
  const payload = (req.body && typeof req.body === 'object' ? req.body : defaultProfileFor(user)) as ProfilePayload
  res.json(writeUserValue(user.id, 'profile', payload))
})

api.get('/projects', requireAuth, (req: AuthedRequest, res) => {
  res.json(readUserValue(req.user!.id, 'projects', []))
})

api.put('/projects', requireAuth, (req: AuthedRequest, res) => {
  const list = Array.isArray(req.body) ? req.body : []
  res.json(writeUserValue(req.user!.id, 'projects', list))
})

api.get('/skillproof/evidence', requireAuth, (req: AuthedRequest, res) => {
  res.json(readUserValue(req.user!.id, 'evidence', []))
})

api.put('/skillproof/evidence', requireAuth, (req: AuthedRequest, res) => {
  const list = Array.isArray(req.body) ? req.body : []
  const sanitized = list.map(item =>
    item && typeof item === 'object' && (item as { status?: string }).status === 'Verified'
      ? { ...(item as Record<string, unknown>), status: 'Demonstrated' }
      : item,
  )
  res.json(writeUserValue(req.user!.id, 'evidence', sanitized))
})

api.get('/assessments/results', requireAuth, (req: AuthedRequest, res) => {
  res.json(readUserValue(req.user!.id, 'results', []))
})

api.put('/assessments/results', requireAuth, (req: AuthedRequest, res) => {
  const list = Array.isArray(req.body) ? req.body : []
  res.json(writeUserValue(req.user!.id, 'results', list))
})

api.get('/users/me/settings', requireAuth, (req: AuthedRequest, res) => {
  res.json(readUserValue(req.user!.id, 'settings', {}))
})

api.put('/users/me/settings', requireAuth, (req: AuthedRequest, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {}
  res.json(writeUserValue(req.user!.id, 'settings', body))
})

api.get('/notifications/read', requireAuth, (req: AuthedRequest, res) => {
  res.json(readUserValue(req.user!.id, 'notifRead', []))
})

api.put('/notifications/read', requireAuth, (req: AuthedRequest, res) => {
  const list = Array.isArray(req.body) ? req.body : []
  res.json(writeUserValue(req.user!.id, 'notifRead', list))
})

api.get('/roadmaps/:careerId/progress', requireAuth, (req: AuthedRequest, res) => {
  res.json(readUserValue(req.user!.id, `roadmap:${req.params.careerId}`, []))
})

api.put('/roadmaps/:careerId/progress', requireAuth, (req: AuthedRequest, res) => {
  const list = Array.isArray(req.body) ? req.body : []
  res.json(writeUserValue(req.user!.id, `roadmap:${req.params.careerId}`, list))
})

// ---- Catalogs & deterministic analytics ----
api.get('/analytics/dashboard', requireAuth, (req: AuthedRequest, res) => {
  res.json(dashboardData(req.user!))
})

api.get('/careers', requireAuth, (_req, res) => {
  res.json(CAREERS)
})

api.get('/careers/matches', requireAuth, (req: AuthedRequest, res) => {
  res.json(dashboardData(req.user!).careers)
})

api.get('/careers/:careerId', requireAuth, (req, res) => {
  const item = CAREERS.find(c => c.id === req.params.careerId)
  if (!item) {
    res.status(404).json({ detail: 'Career not found' })
    return
  }
  res.json(item)
})

api.get('/careers/:careerId/gaps', requireAuth, (req: AuthedRequest, res) => {
  const result = careerGaps(req.user!, String(req.params.careerId))
  if (!result) {
    res.status(404).json({ detail: 'Career not found' })
    return
  }
  res.json(result)
})

api.get('/skills', requireAuth, (_req, res) => {
  res.json(SKILLS)
})

api.get('/resources', requireAuth, (_req, res) => {
  res.json(RESOURCES)
})

api.get('/assessments', requireAuth, (_req, res) => {
  res.json(
    ASSESSMENTS.map(item => ({
      id: item.id,
      title: item.title,
      skill: item.skill,
      questions: item.questions.map(q => ({ q: q.q, options: q.options })),
    })),
  )
})

api.post('/assessments/:assessmentId/submit', requireAuth, (req, res) => {
  const assessment = ASSESSMENTS.find(a => a.id === req.params.assessmentId)
  if (!assessment) {
    res.status(404).json({ detail: 'Assessment not found' })
    return
  }
  const answers = req.body?.answers
  if (!Array.isArray(answers) || answers.length !== assessment.questions.length) {
    res.status(422).json({ detail: 'Submit one answer for every question' })
    return
  }
  const invalid = answers.some(
    (answer, idx) =>
      typeof answer !== 'number' ||
      !Number.isInteger(answer) ||
      answer < 0 ||
      answer >= assessment.questions[idx].options.length,
  )
  if (invalid) {
    res.status(422).json({ detail: 'One or more answers are invalid' })
    return
  }
  const correctAnswers = assessment.questions.map(q => q.answer)
  const score = answers.filter((a, idx) => a === correctAnswers[idx]).length
  const total = assessment.questions.length
  const ratio = total ? score / total : 0
  res.json({
    assessmentId: assessment.id,
    score,
    total,
    percentage: total ? Math.round((100 * score) / total) : 0,
    correctAnswers,
    feedback:
      ratio >= 0.75
        ? 'Strong result. Add a project or demonstration to back it up.'
        : ratio >= 0.5
          ? 'Partial result. Revisit the topics you missed.'
          : 'This skill needs more practice.',
  })
})

api.get('/skillgraph', requireAuth, (req: AuthedRequest, res) => {
  res.json(buildSkillGraph(req.user!))
})

api.post('/what-if', requireAuth, (req: AuthedRequest, res) => {
  const extraSkills = req.body?.extraSkills
  if (!Array.isArray(extraSkills)) {
    res.status(422).json({ detail: 'extraSkills must be a list' })
    return
  }
  res.json(simulateCareerMatches(req.user!, extraSkills))
})

// ---- Gemini AI intelligence routes ----
api.post('/ai/recommendations', requireAuth, async (req: AuthedRequest, res) => {
  try {
    const focusCareerId = typeof req.body?.focusCareerId === 'string' ? req.body.focusCareerId : undefined
    const customGoal = typeof req.body?.customGoal === 'string' ? req.body.customGoal.slice(0, 300) : undefined
    const result = await generateAiRecommendations(req.user!, { focusCareerId, customGoal })
    res.json(result)
  } catch (error) {
    const status = error instanceof GeminiUpstreamError ? error.status : 502
    res.status(status).json({ detail: error instanceof Error ? error.message : 'AI analysis failed' })
  }
})

api.post('/ai/skill-quiz', requireAuth, async (req: AuthedRequest, res) => {
  try {
    const skill = typeof req.body?.skill === 'string' ? req.body.skill : ''
    const quiz = await generateSkillMicroQuiz(req.user!, skill)
    res.json(quiz)
  } catch (error) {
    const status = error instanceof GeminiUpstreamError ? error.status : 502
    res.status(status).json({ detail: error instanceof Error ? error.message : 'Could not generate skill quiz' })
  }
})

api.post('/ai/skill-quiz/submit', requireAuth, (req: AuthedRequest, res) => {
  const quizToken = typeof req.body?.quizToken === 'string' ? req.body.quizToken : ''
  const answers = Array.isArray(req.body?.answers) ? req.body.answers : []
  const result = gradeSkillMicroQuiz(quizToken, answers)
  if ('error' in result) {
    res.status(result.status).json({ detail: result.error })
    return
  }
  res.json(result)
})

api.post('/resume/analyze', requireAuth, (req: AuthedRequest, res) => {
  upload.single('file')(req, res, async uploadErr => {
    if (uploadErr) {
      if (uploadErr instanceof multer.MulterError && uploadErr.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({ detail: 'Resume must be 5 MB or smaller' })
        return
      }
      res.status(400).json({ detail: 'Could not read uploaded file' })
      return
    }

    const file = req.file
    if (!file) {
      res.status(400).json({ detail: 'No file uploaded' })
      return
    }

    const filename = file.originalname || 'resume'
    const lower = filename.toLowerCase()
    if (!lower.endsWith('.pdf') && !lower.endsWith('.docx')) {
      res.status(415).json({ detail: 'Upload a PDF or DOCX file' })
      return
    }
    if (!file.buffer || file.buffer.length === 0) {
      res.status(400).json({ detail: 'The uploaded file is empty' })
      return
    }

    let extracted = ''
    try {
      if (lower.endsWith('.pdf')) {
        const pdf = await getDocumentProxy(new Uint8Array(file.buffer))
        const parsed = await extractText(pdf, { mergePages: true })
        extracted = Array.isArray(parsed.text) ? parsed.text.join('\n') : String(parsed.text ?? '')
      } else {
        const result = await mammoth.extractRawText({ buffer: file.buffer })
        extracted = result.value ?? ''
      }
    } catch {
      res.status(422).json({ detail: 'Could not read this document. Try another PDF or DOCX.' })
      return
    }

    const cleaned = extracted
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()

    if (!cleaned) {
      res.status(422).json({ detail: 'No selectable text found. Scanned image-only PDFs are not supported yet.' })
      return
    }

    try {
      const user = req.user!
      const existingProfile = readUserValue<ProfilePayload>(user.id, 'profile', defaultProfileFor(user))
      const result = await analyzeResumeWithGemini(cleaned, filename, existingProfile)
      res.json(result)
    } catch (error) {
      const status = error instanceof GeminiUpstreamError ? error.status : 502
      res.status(status).json({ detail: error instanceof Error ? error.message : 'Resume AI analysis failed' })
    }
  })
})

app.use('/api/v1', api)

async function start() {
  if (!IS_PROD) {
    const { createServer: createViteServer } = await import('vite')
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false },
      appType: 'spa',
    })
    app.use(vite.middlewares)
  } else {
    const distDir = path.resolve(__dirname, 'dist')
    app.use(express.static(distDir))
    app.get('/{*splat}', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'))
    })
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`AptiNexus server running at http://0.0.0.0:${PORT}`)
  })
}

start()
