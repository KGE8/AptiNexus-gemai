"""Server-side Gemini AI intelligence service for AptiNexus (FastAPI).

Scans the signed-in user's SQL database state (profile, projects, evidence,
assessment results, settings) alongside AptiNexus catalogs to produce dynamic
career targets, course recommendations, profile corrections, and semantic
resume extraction.
"""
import base64
from datetime import datetime, timezone
import hashlib
import hmac
import json
import time
from typing import Callable, Literal, Optional, TypeVar
from urllib.parse import urlparse

from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.catalog_data import CAREERS, RESOURCES, SKILLS
from app.core.config import settings
from app.models import User
from app.services.intelligence import career_match, read_user_value, user_skill_names

VALID_SECTIONS = {
    "education",
    "subjects",
    "technical",
    "soft",
    "interests",
    "experience",
    "projects",
    "certifications",
    "achievements",
    "goals",
    "name",
    "headline",
    "location",
}

VALID_RESOURCE_TYPES = {
    "Course",
    "Documentation",
    "Tutorial",
    "Video",
    "Book",
    "Practical project",
}


class _CareerSuggestionSchema(BaseModel):
    careerId: str
    title: str
    category: str
    compatibility: int = Field(ge=0, le=100)
    rationale: str
    matchedSkills: list[str]
    bridgeSkills: list[str]
    isAdjacentDiscovery: bool


class _CourseRecommendationSchema(BaseModel):
    title: str
    type: str
    targetSkill: str
    level: str
    reason: str
    url: Optional[str] = None


class _ProfileCorrectionSchema(BaseModel):
    action: Literal["add", "normalize", "refine"]
    section: str
    currentValue: Optional[str] = None
    suggestedValue: str
    rationale: str


class _RecommendationsSchema(BaseModel):
    summary: str
    careerSuggestions: list[_CareerSuggestionSchema]
    courseRecommendations: list[_CourseRecommendationSchema]
    profileCorrections: list[_ProfileCorrectionSchema]


class _ResumeSuggestionSchema(BaseModel):
    section: str
    target: str
    text: str
    normalizedSkill: Optional[str] = None
    origin: Literal["explicit", "inferred"]
    confidence: Literal["high", "medium"]
    rationale: str


class _ResumeAnalysisSchema(BaseModel):
    message: str
    suggestions: list[_ResumeSuggestionSchema]
    profileCorrections: list[_ProfileCorrectionSchema]


class _QuizQuestionSchema(BaseModel):
    q: str
    options: list[str]
    correctIndex: int = Field(ge=0, le=3)
    explanation: str


class _SkillQuizSchema(BaseModel):
    title: str
    questions: list[_QuizQuestionSchema]


def _safe_http_url(url: str | None) -> str | None:
    if not url:
        return None
    try:
        parsed = urlparse(url)
        return url if parsed.scheme in {"http", "https"} and parsed.netloc else None
    except ValueError:
        return None


_T = TypeVar("_T")


class GeminiServiceError(RuntimeError):
    def __init__(self, message: str, status_code: int = 502):
        super().__init__(message)
        self.status_code = status_code


def _is_transient_error(exc: Exception) -> bool:
    msg = str(exc)
    upper = msg.upper()
    return (
        "503" in msg
        or "UNAVAILABLE" in upper
        or "HIGH DEMAND" in upper
        or "TEMPORARILY UNAVAILABLE" in upper
        or "429" in msg
        or "RESOURCE_EXHAUSTED" in upper
    )


def _format_gemini_error(exc: Exception) -> GeminiServiceError:
    if isinstance(exc, GeminiServiceError):
        return exc
    msg = str(exc)
    upper = msg.upper()
    if any(tok in upper for tok in ("PERMISSION_DENIED", "API_KEY_INVALID")) or "403" in msg or "400" in msg:
        return GeminiServiceError(
            "Gemini API request could not be authorized. Check your server API key in Settings > Secrets.",
            status_code=403,
        )
    if "429" in msg or "RESOURCE_EXHAUSTED" in upper:
        return GeminiServiceError("Gemini API rate limit reached. Wait a moment and retry.", status_code=429)
    if "503" in msg or "UNAVAILABLE" in upper or "HIGH DEMAND" in upper:
        return GeminiServiceError(
            "Gemini model is temporarily experiencing high demand (503). Please retry in a few seconds.",
            status_code=503,
        )
    if "TIMEOUT" in upper or "TIMED OUT" in upper:
        return GeminiServiceError("Gemini API request timed out. Please try again.", status_code=504)
    return GeminiServiceError(f"Gemini analysis failed: {msg}", status_code=502)


def _call_with_retry(fn: Callable[[], _T]) -> _T:
    delays = (0.0, 0.8, 1.6)
    last_exc: Exception | None = None
    for idx, delay in enumerate(delays):
        if delay > 0:
            time.sleep(delay)
        try:
            return fn()
        except Exception as exc:
            last_exc = exc
            if idx < len(delays) - 1 and _is_transient_error(exc):
                continue
            raise
    assert last_exc is not None
    raise last_exc


def _user_snapshot(db: Session, user: User) -> dict:
    return {
        "profile": read_user_value(
            db,
            user.id,
            "profile",
            {"personal": {"name": user.name, "headline": user.headline, "location": ""}, "sections": {}},
        ),
        "projects": read_user_value(db, user.id, "projects", []),
        "evidence": read_user_value(db, user.id, "evidence", []),
        "results": read_user_value(db, user.id, "results", []),
        "settings": read_user_value(db, user.id, "settings", {}),
    }


def generate_ai_recommendations(
    db: Session,
    user: User,
    focus_career_id: str | None = None,
    custom_goal: str | None = None,
) -> dict:
    api_key = settings.gemini_api_key.strip()
    if not api_key:
        raise GeminiServiceError(
            "Gemini API key is not configured on the server. Add GEMINI_API_KEY in Settings > Secrets.",
            status_code=503,
        )

    from google import genai
    from google.genai import types

    snapshot = _user_snapshot(db, user)
    acquired = sorted(user_skill_names(db, user))
    payload = {
        "userProfile": snapshot["profile"],
        "userProjects": snapshot["projects"],
        "userEvidence": snapshot["evidence"],
        "assessmentResults": snapshot["results"],
        "userSettings": snapshot["settings"],
        "derivedSkills": acquired,
        "focusCareerId": focus_career_id,
        "customGoal": custom_goal,
        "catalogCareers": [
            {"id": c["id"], "title": c["title"], "category": c["category"], "required": c["required"]}
            for c in CAREERS
        ],
        "catalogSkills": [s["name"] for s in SKILLS],
        "catalogResources": [
            {"title": r["title"], "type": r["type"], "skill": r["skill"], "level": r["level"], "url": r.get("url")}
            for r in RESOURCES
        ],
    }

    client = genai.Client(api_key=api_key)
    try:
        response = _call_with_retry(
            lambda: client.models.generate_content(
                model="gemini-4-hydrogen",
                contents=(
                    "Analyze this student's full database state and recommend personalized career targets, "
                    "tailored courses/learning resources, and profile corrections.\n\n"
                    + json.dumps(payload)
                ),
                config=types.GenerateContentConfig(
                    system_instruction=(
                        "You are the AptiNexus Career & Skill Intelligence Engine. Scan the user profile, "
                        "projects, evidence, and assessment results against the provided career, skill, and resource catalogs. "
                        "Infer transferable strengths, highlight adjacent/unexpected career opportunities aligned with "
                        "their interests and abilities, prioritize courses/resources that bridge specific gaps, and "
                        "propose concrete profile corrections (normalizing informal skill names to canonical catalogSkills, "
                        "surfacing skills implied by projects/experience, or refining vague goals/headlines). "
                        "Return 4-5 careerSuggestions, 4-5 courseRecommendations, and up to 4 profileCorrections. "
                        "Keep summary and each rationale to 1 crisp sentence, NEVER assign Verified status, and only include URLs present verbatim in catalogResources."
                    ),
                    response_mime_type="application/json",
                    response_schema=_RecommendationsSchema,
                    thinking_config=types.ThinkingConfig(thinking_level="LOW"),
                ),
            )
        )
    except Exception as exc:
        raise _format_gemini_error(exc) from exc

    parsed: _RecommendationsSchema = response.parsed
    catalog_career_ids = {c["id"] for c in CAREERS}
    catalog_urls = {r["title"].lower(): r["url"] for r in RESOURCES if r.get("url")}
    sections = snapshot["profile"].get("sections", {}) if isinstance(snapshot["profile"], dict) else {}
    existing_tech = {s.lower() for s in sections.get("technical", []) if isinstance(s, str)}

    career_suggestions = []
    for c in parsed.careerSuggestions[:6]:
        career_suggestions.append({
            "careerId": c.careerId if c.careerId in catalog_career_ids else CAREERS[0]["id"],
            "title": c.title,
            "category": c.category or "Engineering",
            "compatibility": max(0, min(100, c.compatibility)),
            "rationale": c.rationale,
            "matchedSkills": c.matchedSkills,
            "bridgeSkills": c.bridgeSkills,
            "isAdjacentDiscovery": c.isAdjacentDiscovery,
        })

    course_recommendations = []
    for idx, r in enumerate(parsed.courseRecommendations[:6]):
        course_recommendations.append({
            "id": f"ai-course-{idx}",
            "title": r.title,
            "type": r.type if r.type in VALID_RESOURCE_TYPES else "Course",
            "targetSkill": r.targetSkill,
            "level": r.level if r.level in {"Beginner", "Intermediate", "Advanced"} else "Intermediate",
            "reason": r.reason,
            "url": catalog_urls.get(r.title.lower()) or _safe_http_url(r.url),
        })

    profile_corrections = []
    for idx, p in enumerate(parsed.profileCorrections):
        if p.section not in VALID_SECTIONS:
            continue
        if p.action == "add" and p.section == "technical" and p.suggestedValue.lower() in existing_tech:
            continue
        profile_corrections.append({
            "id": f"ai-corr-{idx}-{p.section}",
            "action": p.action,
            "section": p.section,
            "currentValue": p.currentValue,
            "suggestedValue": p.suggestedValue,
            "rationale": p.rationale,
        })
        if len(profile_corrections) >= 6:
            break

    return {
        "mode": "gemini",
        "analyzedAt": datetime.now(timezone.utc).isoformat(),
        "summary": parsed.summary,
        "careerSuggestions": career_suggestions,
        "courseRecommendations": course_recommendations,
        "profileCorrections": profile_corrections,
    }


def analyze_resume_with_gemini(
    db: Session,
    user: User,
    text: str,
    filename: str,
) -> dict:
    existing_profile = read_user_value(
        db,
        user.id,
        "profile",
        {"personal": {"name": user.name, "headline": user.headline, "location": ""}, "sections": {}},
    )
    api_key = settings.gemini_api_key.strip()
    if not api_key:
        raise GeminiServiceError(
            "Gemini API key is not configured on the server. Add GEMINI_API_KEY in Settings > Secrets.",
            status_code=503,
        )

    from google import genai
    from google.genai import types

    client = genai.Client(api_key=api_key)
    snippet = text[:14000]
    try:
        response = _call_with_retry(
            lambda: client.models.generate_content(
                model="gemini-4-hydrogen",
                contents=(
                    f"Analyze this uploaded resume text alongside the user's current saved profile and canonical skills catalog.\n\n"
                    f"Resume filename: {filename}\nResume text:\n{snippet}\n\n"
                    f"Existing saved profile:\n{json.dumps(existing_profile)}\n\n"
                    f"Canonical catalog skills:\n{json.dumps([s['name'] for s in SKILLS])}"
                ),
                config=types.GenerateContentConfig(
                    system_instruction=(
                        "You are the AptiNexus Resume Intelligence parser. Extract structured profile items into valid sections "
                        "(education, subjects, technical, soft, interests, experience, projects, certifications, achievements, goals). "
                        "Tag origin as 'explicit' if directly stated, or 'inferred' if reasonably deduced from project/experience context. "
                        "Also compare the resume against existingProfile to generate profileCorrections: add missing canonical skills, "
                        "normalize wording to canonical catalog skill names, or update personal fields (section 'name', 'headline', or 'location') "
                        "if the resume provides a fuller name, headline, or city/location. Never invent credentials or assign Verified status."
                    ),
                    response_mime_type="application/json",
                    response_schema=_ResumeAnalysisSchema,
                    thinking_config=types.ThinkingConfig(thinking_level="LOW"),
                ),
            )
        )
    except Exception as exc:
        raise _format_gemini_error(exc) from exc

    parsed: _ResumeAnalysisSchema = response.parsed
    suggestions = [
        {
            "id": f"resume-ai-{idx}",
            "section": s.section or s.target.title(),
            "target": s.target,
            "text": s.text[:240],
            "normalizedSkill": s.normalizedSkill,
            "origin": s.origin,
            "confidence": s.confidence,
            "rationale": s.rationale,
        }
        for idx, s in enumerate(parsed.suggestions[:40])
        if s.target in VALID_SECTIONS and s.text.strip()
    ]
    corrections = [
        {
            "id": f"resume-corr-{idx}",
            "action": p.action,
            "section": p.section,
            "currentValue": p.currentValue,
            "suggestedValue": p.suggestedValue,
            "rationale": p.rationale,
        }
        for idx, p in enumerate(parsed.profileCorrections[:8])
        if p.section in VALID_SECTIONS and p.suggestedValue.strip()
    ]

    return {
        "filename": filename,
        "extractedCharacters": len(text),
        "mode": "gemini",
        "message": parsed.message,
        "suggestions": suggestions,
        "profileCorrections": corrections,
    }


def _sign_quiz_token(payload: dict) -> str:
    body = {**payload, "exp": int(time.time() * 1000) + 1000 * 60 * 60 * 4}
    encoded = base64.urlsafe_b64encode(json.dumps(body).encode("utf-8")).decode("ascii").rstrip("=")
    secret = (settings.secret_key or "aptinexus-preview-secret-change-in-production").encode("utf-8")
    sig = base64.urlsafe_b64encode(hmac.new(secret, encoded.encode("ascii"), hashlib.sha256).digest()).decode("ascii").rstrip("=")
    return f"{encoded}.{sig}"


def _verify_quiz_token(token: str) -> dict | None:
    if "." not in token:
        return None
    encoded, sig = token.split(".", 1)
    secret = (settings.secret_key or "aptinexus-preview-secret-change-in-production").encode("utf-8")
    expected = base64.urlsafe_b64encode(hmac.new(secret, encoded.encode("ascii"), hashlib.sha256).digest()).decode("ascii").rstrip("=")
    if not hmac.compare_digest(sig, expected):
        return None
    try:
        padding = "=" * (-len(encoded) % 4)
        data = json.loads(base64.urlsafe_b64decode(encoded + padding).decode("utf-8"))
        if not isinstance(data, dict) or data.get("exp", 0) < int(time.time() * 1000):
            return None
        return data
    except Exception:
        return None


def generate_skill_micro_quiz(db: Session, user: User, skill_name: str) -> dict:
    clean_skill = (skill_name or "").strip()[:80]
    if not clean_skill:
        raise GeminiServiceError("Skill name is required.", status_code=422)

    api_key = settings.gemini_api_key.strip()
    if not api_key:
        raise GeminiServiceError(
            "Gemini API key is not configured on the server. Add GEMINI_API_KEY in Settings > Secrets.",
            status_code=503,
        )

    from google import genai
    from google.genai import types

    snapshot = _user_snapshot(db, user)
    catalog_skill = next((s for s in SKILLS if s["name"].lower() == clean_skill.lower()), {"name": clean_skill})
    sections = snapshot["profile"].get("sections", {}) if isinstance(snapshot["profile"], dict) else {}
    personal = snapshot["profile"].get("personal", {}) if isinstance(snapshot["profile"], dict) else {}

    client = genai.Client(api_key=api_key)
    try:
        response = _call_with_retry(
            lambda: client.models.generate_content(
                model="gemini-4-hydrogen",
                contents=(
                    f"Generate a 4-question multiple-choice technical micro-assessment to verify practical understanding "
                    f"of the claimed skill '{clean_skill}'.\n\n"
                    f"Catalog skill metadata: {json.dumps(catalog_skill)}\n"
                    f"Student profile context: {json.dumps({'headline': personal.get('headline', ''), 'projects': sections.get('projects', []), 'experience': sections.get('experience', [])})}"
                ),
                config=types.GenerateContentConfig(
                    system_instruction=(
                        "You are the AptiNexus Claimed-Skill Verification Engine. Create exactly 4 practical, scenario-based "
                        "multiple-choice questions for the requested skill. Each question must have 4 concise options, a 0-based "
                        "correctIndex (0, 1, 2, or 3), and a 1-sentence explanation."
                    ),
                    response_mime_type="application/json",
                    response_schema=_SkillQuizSchema,
                    thinking_config=types.ThinkingConfig(thinking_level="LOW"),
                ),
            )
        )
    except Exception as exc:
        raise _format_gemini_error(exc) from exc

    parsed: _SkillQuizSchema = response.parsed
    valid_questions = []
    for q in parsed.questions[:4]:
        opts = [str(o) for o in q.options[:4]]
        while len(opts) < 4:
            opts.append(f"Option {len(opts) + 1}")
        idx = max(0, min(len(opts) - 1, int(q.correctIndex)))
        valid_questions.append({
            "q": q.q,
            "options": opts,
            "correctIndex": idx,
            "explanation": q.explanation,
        })

    if not valid_questions:
        raise GeminiServiceError("Gemini returned an empty question set.", status_code=502)

    quiz_id = f"ai-quiz-{int(time.time() * 1000)}"
    quiz_token = _sign_quiz_token({
        "id": quiz_id,
        "skill": clean_skill,
        "answers": [q["correctIndex"] for q in valid_questions],
        "explanations": [q["explanation"] for q in valid_questions],
    })

    return {
        "id": quiz_id,
        "title": parsed.title or f"{clean_skill} — Claimed Skill Check",
        "skill": clean_skill,
        "mode": "gemini",
        "quizToken": quiz_token,
        "questions": [{"q": q["q"], "options": q["options"]} for q in valid_questions],
    }


def grade_skill_micro_quiz(quiz_token: str, answers: list) -> dict:
    verified = _verify_quiz_token(quiz_token or "")
    if not verified:
        raise GeminiServiceError("Invalid or expired quiz session. Generate a new quiz.", status_code=422)
    expected = verified.get("answers", [])
    if not isinstance(answers, list) or len(answers) != len(expected):
        raise GeminiServiceError("Submit one answer for every question.", status_code=422)
    if any(type(a) is not int or a < 0 or a > 3 for a in answers):
        raise GeminiServiceError("One or more answers are out of range.", status_code=422)

    score = sum(a == c for a, c in zip(answers, expected))
    total = len(expected)
    ratio = score / total if total else 0
    skill = str(verified.get("skill", "Skill"))
    return {
        "assessmentId": str(verified.get("id", "ai-quiz")),
        "skill": skill,
        "score": score,
        "total": total,
        "percentage": round(100 * score / total) if total else 0,
        "correctAnswers": expected,
        "explanations": verified.get("explanations", []),
        "feedback": (
            f"Strong result ({score}/{total}). Recorded as Practised evidence for {skill} in SkillProof."
            if ratio >= 0.75
            else f"Partial result ({score}/{total}). Score 70% or higher to record Practised evidence in SkillProof."
            if ratio >= 0.5
            else f"Keep practising {skill} and try another micro-quiz when ready."
        ),
    }
