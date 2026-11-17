"""Transparent, profile-driven AptiNexus recommendations.

These are deterministic recommendations, not generative-AI output. They use only
information the signed-in user has saved in their own AptiNexus account.
"""
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.catalog_data import CAREERS, SKILLS
from app.models import User, UserData


def read_user_value(db: Session, user_id: int, key: str, default: Any) -> Any:
    row = db.scalar(
        select(UserData).where(
            UserData.user_id == user_id,
            UserData.data_key == key,
        )
    )
    return row.value if row is not None else default


def _strings(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item.strip() for item in value if isinstance(item, str) and item.strip()]


def user_skill_names(db: Session, user: User) -> set[str]:
    profile = read_user_value(db, user.id, "profile", {})
    names: set[str] = set()
    if isinstance(profile, dict):
        sections = profile.get("sections", {})
        if isinstance(sections, dict):
            for key in ("technical", "subjects", "projects", "certifications", "experience"):
                names.update(_strings(sections.get(key)))
    evidence = read_user_value(db, user.id, "evidence", [])
    if isinstance(evidence, list):
        for item in evidence:
            if not isinstance(item, dict):
                continue
            skill = item.get("skill") or item.get("skillName") or item.get("name")
            if isinstance(skill, str) and skill.strip():
                names.add(skill.strip())
    return names


def evidenced_skill_names(db: Session, user: User) -> set[str]:
    evidence = read_user_value(db, user.id, "evidence", [])
    projects = read_user_value(db, user.id, "projects", [])
    results = read_user_value(db, user.id, "results", [])
    names: set[str] = set()
    if isinstance(evidence, list):
        for item in evidence:
            if not isinstance(item, dict):
                continue
            status = str(item.get("status", "")).lower()
            if status not in {"demonstrated", "verified"}:
                continue
            skill = item.get("skill") or item.get("skillName") or item.get("name")
            if isinstance(skill, str) and skill.strip():
                names.add(skill.strip())
    if isinstance(projects, list):
        for proj in projects:
            if isinstance(proj, dict) and isinstance(proj.get("link"), str) and proj.get("link").strip():
                names.update(_strings(proj.get("skills")))
    if isinstance(results, list):
        for res in results:
            if not isinstance(res, dict):
                continue
            score = res.get("score", 0)
            total = res.get("total", 0)
            skill = res.get("skill")
            if isinstance(score, (int, float)) and isinstance(total, (int, float)) and total > 0 and score / total >= 0.7:
                if isinstance(skill, str) and skill.strip():
                    names.add(skill.strip())
    return names


def profile_completion(db: Session, user: User) -> int:
    profile = read_user_value(
        db,
        user.id,
        "profile",
        {"personal": {"name": user.name, "headline": user.headline, "location": ""}, "sections": {}},
    )
    if not isinstance(profile, dict):
        profile = {}
    personal = profile.get("personal", {"name": user.name, "headline": user.headline, "location": ""})
    sections = profile.get("sections", {})
    if not isinstance(personal, dict):
        personal = {}
    if not isinstance(sections, dict):
        sections = {}
    section_ids = [
        "education", "subjects", "technical", "soft", "interests",
        "experience", "projects", "certifications", "achievements", "goals",
    ]
    filled_sections = sum(bool(_strings(sections.get(key))) for key in section_ids)
    filled_personal = sum(
        bool(value.strip()) for value in personal.values() if isinstance(value, str)
    )
    return round(100 * (filled_sections + filled_personal) / (len(section_ids) + 3))


def career_match(career: dict, acquired: set[str]) -> dict:
    required = career.get("required", [])
    matched = [name for name in required if name in acquired]
    missing = [name for name in required if name not in acquired]
    compatibility = round(100 * len(matched) / len(required)) if required else 0
    return {
        "id": career["id"],
        "title": career["title"],
        "category": career["category"],
        "compatibility": compatibility,
        "missing": missing,
        "matched": matched,
        "requiredCount": len(required),
        "matchedCount": len(matched),
        "method": "Based on skills listed in your profile and submitted evidence.",
    }


def dashboard_data(db: Session, user: User) -> dict:
    acquired = user_skill_names(db, user)
    evidenced = evidenced_skill_names(db, user)
    skill_rows = []
    for item in SKILLS:
        name = item["name"]
        if name not in acquired:
            continue
        status = "Demonstrated" if name in evidenced else "Claimed"
        skill_rows.append({
            "id": name.lower().replace(" ", "-"),
            "name": name,
            "category": item["category"],
            "level": 100 if status == "Demonstrated" else 65,
            "status": status,
        })
    matches = sorted(
        (career_match(career, acquired) for career in CAREERS),
        key=lambda item: (-item["compatibility"], item["title"]),
    )
    results = read_user_value(db, user.id, "results", [])
    completed = len(results) if isinstance(results, list) else 0
    demonstrated = sum(1 for item in skill_rows if item["status"] == "Demonstrated")
    return {
        "profileCompletion": profile_completion(db, user),
        "skills": skill_rows,
        "careers": matches,
        "progress": [
            {"month": "Initial", "skills": max(1, int(len(acquired) * 0.4)), "demonstrated": 0},
            {"month": "Practised", "skills": max(1, int(len(acquired) * 0.75)), "demonstrated": demonstrated},
            {"month": "Current", "skills": len(acquired), "demonstrated": demonstrated},
        ],
        "assessmentCount": completed,
    }

def career_gaps(db: Session, user: User, career_id: str) -> dict:
    career = next((item for item in CAREERS if item["id"] == career_id), None)
    if career is None:
        return None
    acquired = user_skill_names(db, user)
    required = career.get("required", [])
    return {
        "careerId": career_id,
        "strengths": [name for name in required if name in acquired],
        "missing": [name for name in required if name not in acquired],
        "optional": [
            item["name"] for item in SKILLS
            if item["name"] not in required
            and item["name"] not in acquired
            and any(related in required for related in item.get("related", []))
        ][:3],
        "method": "Compares skills in your saved profile and evidence with this career's listed requirements.",
    }


def simulate_career_matches(db: Session, user: User, extra_skills: list[str]) -> list[dict]:
    acquired = user_skill_names(db, user)
    hypothetical = acquired | {name.strip() for name in extra_skills if isinstance(name, str) and name.strip()}
    current = {item["id"]: item for item in (career_match(c, acquired) for c in CAREERS)}
    projected = []
    for career in CAREERS:
        before = current[career["id"]]["compatibility"]
        after = career_match(career, hypothetical)["compatibility"]
        projected.append({
            "id": career["id"],
            "current": before,
            "hypothetical": after,
            "change": after - before,
            "stillNeeded": [name for name in career.get("required", []) if name not in hypothetical],
        })
    return sorted(projected, key=lambda item: (-item["hypothetical"], item["id"]))


def build_notifications(db: Session, user: User) -> list[dict]:
    profile = read_user_value(
        db,
        user.id,
        "profile",
        {"personal": {"name": user.name, "headline": user.headline, "location": ""}, "sections": {}},
    )
    results = read_user_value(db, user.id, "results", [])
    settings = read_user_value(db, user.id, "settings", {})
    if not isinstance(settings, dict):
        settings = {}
    sections = profile.get("sections", {}) if isinstance(profile, dict) else {}
    technical = _strings(sections.get("technical")) if isinstance(sections, dict) else []
    evidenced_lower = {s.lower() for s in evidenced_skill_names(db, user)}
    items: list[dict] = []

    if settings.get("n_recs", True) is not False:
        unverified = [s for s in technical if s.lower() not in evidenced_lower]
        for skill in unverified[:2]:
            items.append({
                "id": f"claim-verify-{skill.lower().replace(' ', '-')}",
                "type": "Skill verification",
                "text": f'Your claimed skill "{skill}" has no verification evidence yet. Take a 4-question Gemini micro-test to mark it Practised.',
                "link": f"/app/assessments?skill={skill}",
                "actionLabel": "Take micro-test",
            })

    if settings.get("n_results", True) is not False and isinstance(results, list) and results:
        latest = results[-1]
        if isinstance(latest, dict):
            skill = str(latest.get("skill", "Skill"))
            score = latest.get("score", 0)
            total = latest.get("total", 4)
            items.append({
                "id": f"quiz-result-{latest.get('id', len(results))}",
                "type": "Assessment result",
                "text": f"You scored {score}/{total} on {latest.get('assessment', skill)} ({skill}).",
                "link": "/app/skillproof",
                "actionLabel": "View SkillProof",
            })

    acquired = user_skill_names(db, user)
    matches = sorted(
        (career_match(c, acquired) for c in CAREERS),
        key=lambda item: (-item["compatibility"], item["title"]),
    )
    top = matches[0] if matches else None
    if settings.get("n_recs", True) is not False and top:
        next_skill = top["missing"][0] if top["missing"] else None
        items.append({
            "id": f"career-top-{top['id']}-{top['compatibility']}",
            "type": "Career insight",
            "text": (
                f'{top["title"]} is your strongest match (~{top["compatibility"]}%). Adding "{next_skill}" will directly increase your compatibility.'
                if next_skill
                else f"You match 100% of the listed skills for {top['title']}. Link project evidence in SkillProof to demonstrate them."
            ),
            "link": f"/app/gaps?career={top['id']}",
            "actionLabel": "Analyse skill gaps",
        })

    if settings.get("n_milestones", True) is not False and top and top["missing"]:
        done = read_user_value(db, user.id, f"roadmap:{top['id']}", [])
        done_count = len(done) if isinstance(done, list) else 0
        total_tasks = len(top["missing"]) * 3
        items.append({
            "id": f"roadmap-{top['id']}-{done_count}",
            "type": "Roadmap milestone",
            "text": f"Your {top['title']} roadmap has {done_count} of {total_tasks} learning tasks completed. Next focus: {top['missing'][0]}.",
            "link": f"/app/roadmap?career={top['id']}",
            "actionLabel": "Open roadmap",
        })

    if settings.get("n_reminders", True) is not False:
        hours = settings.get("hours", 5)
        items.append({
            "id": f"goal-hours-{hours}",
            "type": "Roadmap milestone",
            "text": f"Your weekly learning target is {hours} hours. Use the Gemini Advisor on Learning Resources to pick your next course.",
            "link": "/app/resources",
            "actionLabel": "View resources",
        })

    pct = profile_completion(db, user)
    if settings.get("n_profile", True) is not False and pct < 100:
        items.append({
            "id": f"profile-pct-{pct}",
            "type": "Profile completion",
            "text": f"Your profile is {pct}% complete. Upload your latest resume so Gemini can extract missing skills and achievements.",
            "link": "/app/resume",
            "actionLabel": "Upload resume",
        })

    return items

