import type { ProfileData } from '../data/profile'
import type { ProfileCorrection } from '../types'

function hasCaseInsensitive(list: string[], value: string): boolean {
  const target = value.trim().toLowerCase()
  return list.some(item => item.trim().toLowerCase() === target)
}

export function applyProfileCorrection(profile: ProfileData, correction: ProfileCorrection): ProfileData {
  const next: ProfileData = {
    personal: { ...profile.personal },
    sections: { ...profile.sections },
  }
  const value = correction.suggestedValue.trim()
  if (!value) return next

  if (correction.section === 'name') {
    next.personal.name = value
    return next
  }
  if (correction.section === 'headline') {
    next.personal.headline = value
    return next
  }
  if (correction.section === 'location') {
    next.personal.location = value
    return next
  }

  const sectionKey = correction.section
  const existing = [...(next.sections[sectionKey] ?? [])]

  if (correction.action === 'normalize' && correction.currentValue) {
    const oldLower = correction.currentValue.trim().toLowerCase()
    const filtered = existing.filter(item => item.trim().toLowerCase() !== oldLower)
    if (!hasCaseInsensitive(filtered, value)) filtered.push(value)
    next.sections[sectionKey] = filtered
    return next
  }

  if (!hasCaseInsensitive(existing, value)) {
    next.sections[sectionKey] = [...existing, value]
  }
  return next
}

export function addSkillToProfile(profile: ProfileData, skillName: string): { profile: ProfileData; added: boolean } {
  const value = skillName.trim()
  if (!value) return { profile, added: false }
  const existing = [...(profile.sections.technical ?? [])]
  if (hasCaseInsensitive(existing, value)) return { profile, added: false }
  return {
    profile: {
      personal: { ...profile.personal },
      sections: { ...profile.sections, technical: [...existing, value] },
    },
    added: true,
  }
}
