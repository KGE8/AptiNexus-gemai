import crypto from 'node:crypto'
import { CAREERS, SKILLS, type CareerItem } from './catalogs.ts'

export interface UserRecord {
  id: number
  name: string
  email: string
  headline: string
  passwordHash: string
  createdAt: string
}

export interface ProfilePayload {
  personal: { name: string; headline: string; location: string }
  sections: Record<string, string[]>
}

const TOKEN_SECRET = process.env.SECRET_KEY || 'aptinexus-preview-secret-change-in-production'
const TOKEN_TTL_MS = 1000 * 60 * 60 * 12

const usersById = new Map<number, UserRecord>()
const usersByEmail = new Map<string, UserRecord>()
const userDataStore = new Map<string, unknown>()
let nextUserId = 1

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex')
  const derived = crypto.scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${derived}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, key] = stored.split(':')
  if (!salt || !key) return false
  const derived = crypto.scryptSync(password, salt, 64)
  const storedBuf = Buffer.from(key, 'hex')
  if (derived.length !== storedBuf.length) return false
  return crypto.timingSafeEqual(derived, storedBuf)
}

export function createAccessToken(userId: number): string {
  const payload = Buffer.from(JSON.stringify({ sub: String(userId), exp: Date.now() + TOKEN_TTL_MS })).toString('base64url')
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('base64url')
  return `${payload}.${sig}`
}

export function decodeAccessToken(token: string): number | null {
  const [payload, sig] = token.split('.')
  if (!payload || !sig) return null
  const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('base64url')
  const sigBuf = Buffer.from(sig)
  const expBuf = Buffer.from(expected)
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { sub?: string; exp?: number }
    if (!parsed.sub || !parsed.exp || parsed.exp < Date.now()) return null
    const id = Number(parsed.sub)
    return Number.isInteger(id) && id > 0 ? id : null
  } catch {
    return null
  }
}

export function publicUser(user: UserRecord) {
  return { id: String(user.id), name: user.name, email: user.email, headline: user.headline }
}

export function findUserByEmail(email: string): UserRecord | undefined {
  return usersByEmail.get(email.trim().toLowerCase())
}

export function findUserById(id: number): UserRecord | undefined {
  return usersById.get(id)
}

export function createUser(name: string, email: string, password: string, headline = 'Student'): UserRecord {
  const normalized = email.trim().toLowerCase()
  const record: UserRecord = {
    id: nextUserId++,
    name: name.trim(),
    email: normalized,
    headline,
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString(),
  }
  usersById.set(record.id, record)
  usersByEmail.set(normalized, record)
  return record
}

export function readUserValue<T>(userId: number, key: string, fallback: T): T {
  const k = `${userId}:${key}`
  return userDataStore.has(k) ? (structuredClone(userDataStore.get(k)) as T) : structuredClone(fallback)
}

export function writeUserValue<T>(userId: number, key: string, value: T): T {
  userDataStore.set(`${userId}:${key}`, structuredClone(value))
  return value
}

// Seed a realistic demo student account so reviewers can test immediately without manual setup.
function seedDemoAccount() {
  const demo = createUser('Aarav Shetty', 'demo@aptinexus.app', 'demo12345', 'Mechanical engineering student')
  writeUserValue<ProfilePayload>(demo.id, 'profile', {
    personal: { name: demo.name, headline: demo.headline, location: 'Bengaluru' },
    sections: {
      education: ['B.E. Mechanical Engineering (in progress)'],
      subjects: ['Engineering Mechanics', 'Engineering Mathematics', 'Circuit Theory'],
      technical: ['Python', 'CAD Design', 'Embedded C', 'Control Systems'],
      soft: ['Teamwork', 'Technical Writing'],
      interests: ['Autonomous mobile robots', 'Computer vision', 'Smart manufacturing'],
      experience: ['Manufacturing Internship — 6 weeks on CNC and assembly line'],
      projects: ['Line-following Rover with PID steering', '3-DOF Robotic Arm'],
      certifications: ['Python Course Certificate'],
      achievements: ['Finalist in collegiate robotics challenge'],
      goals: ['Transition into robotics or mechatronics systems engineering'],
    },
  })
  writeUserValue(demo.id, 'projects', [
    { id: 'p1', title: 'Line-following Rover', desc: 'Arduino rover with PID steering.', tech: ['Arduino', 'C'], skills: ['Embedded C', 'Control Systems'], link: '', image: '' },
    { id: 'p2', title: '3-DOF Robotic Arm', desc: 'Designed, printed and programmed a small arm.', tech: ['Fusion 360', 'Python'], skills: ['CAD Design', 'Python'], link: '', image: '' },
  ])
  writeUserValue(demo.id, 'evidence', [])
  writeUserValue(demo.id, 'results', [])
  writeUserValue(demo.id, 'settings', { focus: 'Engineering', hours: 6, n_reminders: true, n_milestones: true, n_recs: true, n_results: true, n_profile: false, share: false, analytics: false })
}
seedDemoAccount()

function cleanStrings(val: unknown): string[] {
  if (!Array.isArray(val)) return []
  return val.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map(v => v.trim())
}

export function defaultProfileFor(user: UserRecord): ProfilePayload {
  return {
    personal: { name: user.name, headline: user.headline, location: '' },
    sections: {},
  }
}

export function getFullUserSnapshot(user: UserRecord) {
  const profile = readUserValue<ProfilePayload>(user.id, 'profile', defaultProfileFor(user))
  const projects = readUserValue<Array<Record<string, unknown>>>(user.id, 'projects', [])
  const evidence = readUserValue<Array<Record<string, unknown>>>(user.id, 'evidence', [])
  const results = readUserValue<Array<Record<string, unknown>>>(user.id, 'results', [])
  const settings = readUserValue<Record<string, unknown>>(user.id, 'settings', {})
  return { profile, projects, evidence, results, settings }
}

export function userSkillNames(user: UserRecord): Set<string> {
  const { profile, evidence, projects } = getFullUserSnapshot(user)
  const names = new Set<string>()
  const sections = profile?.sections ?? {}
  for (const key of ['technical', 'subjects', 'projects', 'certifications', 'experience']) {
    for (const s of cleanStrings(sections[key])) names.add(s)
  }
  for (const item of evidence) {
    const skill = (item.skill || item.skillName || item.name) as string | undefined
    if (typeof skill === 'string' && skill.trim()) names.add(skill.trim())
  }
  for (const proj of projects) {
    for (const s of cleanStrings(proj.skills)) names.add(s)
  }
  return names
}

export function evidencedSkillNames(user: UserRecord): Set<string> {
  const { evidence, projects, results } = getFullUserSnapshot(user)
  const names = new Set<string>()
  for (const item of evidence) {
    const st = String(item.status ?? '').toLowerCase()
    if (st === 'demonstrated' || st === 'verified') {
      const skill = (item.skill || item.skillName || item.name) as string | undefined
      if (typeof skill === 'string' && skill.trim()) names.add(skill.trim())
    }
  }
  for (const proj of projects) {
    if (typeof proj.link === 'string' && proj.link.trim()) {
      for (const s of cleanStrings(proj.skills)) names.add(s)
    }
  }
  for (const r of results) {
    const score = Number(r.score ?? 0)
    const total = Number(r.total ?? 0)
    if (total > 0 && score / total >= 0.7 && typeof r.skill === 'string') {
      names.add(r.skill.trim())
    }
  }
  return names
}

export function profileCompletion(user: UserRecord): number {
  const profile = readUserValue<ProfilePayload>(user.id, 'profile', defaultProfileFor(user))
  const sectionIds = ['education', 'subjects', 'technical', 'soft', 'interests', 'experience', 'projects', 'certifications', 'achievements', 'goals']
  const filledSections = sectionIds.filter(k => cleanStrings(profile.sections?.[k]).length > 0).length
  const filledPersonal = Object.values(profile.personal ?? {}).filter(v => typeof v === 'string' && v.trim().length > 0).length
  return Math.round((100 * (filledSections + filledPersonal)) / (sectionIds.length + 3))
}

export function careerMatch(career: CareerItem, acquired: Set<string>) {
  const acquiredLower = new Set(Array.from(acquired).map(s => s.toLowerCase()))
  const matched = career.required.filter(s => acquiredLower.has(s.toLowerCase()))
  const missing = career.required.filter(s => !acquiredLower.has(s.toLowerCase()))
  const compatibility = career.required.length ? Math.round((100 * matched.length) / career.required.length) : 0
  return {
    id: career.id,
    title: career.title,
    category: career.category,
    compatibility,
    missing,
    matched,
    requiredCount: career.required.length,
    matchedCount: matched.length,
    method: 'Based on skills listed in your profile and submitted evidence.',
  }
}

export function allCareerMatches(user: UserRecord) {
  const acquired = userSkillNames(user)
  return CAREERS.map(c => careerMatch(c, acquired)).sort(
    (a, b) => b.compatibility - a.compatibility || a.title.localeCompare(b.title),
  )
}

export function dashboardData(user: UserRecord) {
  const { projects, evidence, results } = getFullUserSnapshot(user)
  const acquired = userSkillNames(user)
  const acquiredLower = new Set(Array.from(acquired).map(s => s.toLowerCase()))
  const evidenced = evidencedSkillNames(user)
  const evidencedLower = new Set(Array.from(evidenced).map(s => s.toLowerCase()))

  const practisedLower = new Set<string>()
  for (const e of evidence) {
    const sk = (e.skill || e.skillName || e.name) as string | undefined
    if (typeof sk === 'string' && sk.trim()) practisedLower.add(sk.trim().toLowerCase())
  }
  for (const p of projects) {
    for (const sk of cleanStrings(p.skills)) practisedLower.add(sk.toLowerCase())
  }
  for (const r of results) {
    const score = Number(r.score ?? 0)
    const total = Number(r.total ?? 0)
    if (total > 0 && score / total >= 0.7 && typeof r.skill === 'string') {
      practisedLower.add(r.skill.trim().toLowerCase())
    }
  }

  const skillRows = SKILLS.filter(s => acquiredLower.has(s.name.toLowerCase())).map(s => {
    const key = s.name.toLowerCase()
    const status = evidencedLower.has(key)
      ? 'Demonstrated'
      : practisedLower.has(key)
        ? 'Practised'
        : 'Claimed'
    return {
      id: s.name.toLowerCase().replace(/\s+/g, '-'),
      name: s.name,
      category: s.category,
      level: status === 'Demonstrated' ? 95 : status === 'Practised' ? 75 : 45,
      status,
    }
  })

  const matches = allCareerMatches(user)
  const demonstrated = skillRows.filter(s => s.status === 'Demonstrated').length
  const practisedCount = skillRows.filter(s => s.status === 'Practised' || s.status === 'Demonstrated').length
  const totalSkills = acquired.size
  return {
    profileCompletion: profileCompletion(user),
    skills: skillRows,
    careers: matches,
    progress: [
      { month: 'Initial', skills: Math.max(1, Math.floor(totalSkills * 0.4)), demonstrated: 0 },
      { month: 'Practised', skills: Math.max(1, Math.floor(totalSkills * 0.75)), demonstrated: Math.min(demonstrated, practisedCount) },
      { month: 'Current', skills: totalSkills, demonstrated },
    ],
    assessmentCount: Array.isArray(results) ? results.length : 0,
  }
}

export function careerGaps(user: UserRecord, careerId: string) {
  const career = CAREERS.find(c => c.id === careerId)
  if (!career) return null
  const acquired = userSkillNames(user)
  const acquiredLower = new Set(Array.from(acquired).map(s => s.toLowerCase()))
  return {
    careerId,
    strengths: career.required.filter(s => acquiredLower.has(s.toLowerCase())),
    missing: career.required.filter(s => !acquiredLower.has(s.toLowerCase())),
    optional: SKILLS.filter(
      s => !career.required.includes(s.name) && !acquiredLower.has(s.name.toLowerCase()) && s.related.some(r => career.required.includes(r)),
    )
      .slice(0, 3)
      .map(s => s.name),
    method: "Compares skills in your saved profile and evidence with this career's listed requirements.",
  }
}

export function simulateCareerMatches(user: UserRecord, extraSkills: string[]) {
  const acquired = userSkillNames(user)
  const hypothetical = new Set([...acquired, ...cleanStrings(extraSkills)])
  return CAREERS.map(career => {
    const before = careerMatch(career, acquired).compatibility
    const after = careerMatch(career, hypothetical).compatibility
    return {
      id: career.id,
      current: before,
      hypothetical: after,
      change: after - before,
      stillNeeded: careerMatch(career, hypothetical).missing,
    }
  }).sort((a, b) => b.hypothetical - a.hypothetical || a.id.localeCompare(b.id))
}

export function buildSkillGraph(user: UserRecord) {
  const { profile, evidence } = getFullUserSnapshot(user)
  const acquired = new Set<string>(cleanStrings(profile.sections?.technical))
  for (const item of evidence) {
    const name = (item.skill || item.skillName || item.name) as string | undefined
    if (typeof name === 'string' && name.trim()) acquired.add(name.trim())
  }
  const demonstrated = evidencedSkillNames(user)
  const catalogByName = new Map(SKILLS.map(s => [s.name.toLowerCase(), s]))
  const nodes: Array<{ id: string; label: string; cat: string; status?: string; desc: string }> = []
  const skillIds = new Map<string, string>()

  for (const name of Array.from(acquired).sort((a, b) => a.localeCompare(b))) {
    const catalog = catalogByName.get(name.toLowerCase())
    const nodeId = `skill-${name.toLowerCase().trim().split(/\s+/).join('-')}`
    skillIds.set(name.toLowerCase(), nodeId)
    nodes.push({
      id: nodeId,
      label: name,
      cat: 'skill',
      status: demonstrated.has(name) ? 'Demonstrated' : 'Claimed',
      desc: catalog?.desc ?? 'A skill saved in your profile.',
    })
  }

  const edges: [string, string][] = []
  const seenEdges = new Set<string>()
  for (const name of acquired) {
    const catalog = catalogByName.get(name.toLowerCase())
    const sourceId = skillIds.get(name.toLowerCase())
    if (!catalog || !sourceId) continue
    for (const related of catalog.related) {
      const targetId = skillIds.get(related.toLowerCase())
      if (targetId && targetId !== sourceId) {
        const pair = [sourceId, targetId].sort() as [string, string]
        const key = `${pair[0]}::${pair[1]}`
        if (!seenEdges.has(key)) {
          seenEdges.add(key)
          edges.push(pair)
        }
      }
    }
  }

  for (const career of CAREERS) {
    const matchedIds = career.required.map(r => skillIds.get(r.toLowerCase())).filter((v): v is string => Boolean(v))
    if (!matchedIds.length) continue
    const careerNodeId = `career-${career.id}`
    nodes.push({
      id: careerNodeId,
      label: career.title,
      cat: 'career',
      desc: 'A possible career path connected to skills in your profile.',
    })
    for (const m of matchedIds) edges.push([m, careerNodeId])
  }

  return { nodes, edges }
}

export interface LiveNotification {
  id: string
  type: 'Skill verification' | 'Roadmap milestone' | 'Profile completion' | 'Assessment result' | 'Career insight'
  text: string
  link?: string
  actionLabel?: string
}

export function buildNotifications(user: UserRecord): LiveNotification[] {
  const { profile, results, settings } = getFullUserSnapshot(user)
  const evidenced = new Set(Array.from(evidencedSkillNames(user)).map(s => s.toLowerCase()))
  const technical = cleanStrings(profile.sections?.technical)
  const items: LiveNotification[] = []

  const allowRecs = settings.n_recs !== false
  const allowResults = settings.n_results !== false
  const allowMilestones = settings.n_milestones !== false
  const allowProfile = settings.n_profile !== false
  const allowReminders = settings.n_reminders !== false

  // 1. Unverified claimed skills ready for a Gemini micro-test
  if (allowRecs) {
    const unverified = technical.filter(s => !evidenced.has(s.toLowerCase()))
    for (const skill of unverified.slice(0, 2)) {
      items.push({
        id: `claim-verify-${skill.toLowerCase().replace(/\s+/g, '-')}`,
        type: 'Skill verification',
        text: `Your claimed skill "${skill}" has no verification evidence yet. Take a 4-question Gemini micro-test to mark it Practised.`,
        link: `/app/assessments?skill=${encodeURIComponent(skill)}`,
        actionLabel: 'Take micro-test',
      })
    }
  }

  // 2. Latest assessment results
  if (allowResults && results.length > 0) {
    const latest = results[results.length - 1]
    const skill = String(latest.skill ?? 'Skill')
    const score = Number(latest.score ?? 0)
    const total = Number(latest.total ?? 4)
    items.push({
      id: `quiz-result-${String(latest.id ?? results.length)}`,
      type: 'Assessment result',
      text: `You scored ${score}/${total} on ${String(latest.assessment ?? skill)} (${skill}).`,
      link: '/app/skillproof',
      actionLabel: 'View SkillProof',
    })
  }

  // 3. Top career match & bridge skill insight
  const matches = allCareerMatches(user)
  const top = matches[0]
  if (allowRecs && top) {
    const nextSkill = top.missing[0]
    items.push({
      id: `career-top-${top.id}-${top.compatibility}`,
      type: 'Career insight',
      text: nextSkill
        ? `${top.title} is your strongest match (~${top.compatibility}%). Adding "${nextSkill}" will directly increase your compatibility.`
        : `You match 100% of the listed skills for ${top.title}. Link project evidence in SkillProof to demonstrate them.`,
      link: `/app/gaps?career=${top.id}`,
      actionLabel: 'Analyse skill gaps',
    })
  }

  // 4. Active roadmap milestone
  if (allowMilestones && top && top.missing.length > 0) {
    const done = readUserValue<string[]>(user.id, `roadmap:${top.id}`, [])
    const totalTasks = top.missing.length * 3
    items.push({
      id: `roadmap-${top.id}-${done.length}`,
      type: 'Roadmap milestone',
      text: `Your ${top.title} roadmap has ${done.length} of ${totalTasks} learning tasks completed. Next focus: ${top.missing[0]}.`,
      link: `/app/roadmap?career=${top.id}`,
      actionLabel: 'Open roadmap',
    })
  }

  // 5. Weekly learning goal reminder from user settings
  if (allowReminders) {
    const hours = Number(settings.hours ?? 5)
    items.push({
      id: `goal-hours-${hours}`,
      type: 'Roadmap milestone',
      text: `Your weekly learning target is ${hours} hours. Use the Gemini Advisor on Learning Resources to pick your next course.`,
      link: '/app/resources',
      actionLabel: 'View resources',
    })
  }

  // 6. Profile completion gaps
  const pct = profileCompletion(user)
  if (allowProfile && pct < 100) {
    items.push({
      id: `profile-pct-${pct}`,
      type: 'Profile completion',
      text: `Your profile is ${pct}% complete. Upload your latest resume so Gemini can extract missing skills and achievements.`,
      link: '/app/resume',
      actionLabel: 'Upload resume',
    })
  }

  return items
}

