from fastapi import APIRouter, Body, Depends, HTTPException, File, UploadFile
from sqlalchemy.orm import Session

from app.catalog_data import ASSESSMENTS, CAREERS, RESOURCES, SKILLS
from app.core.database import get_db
from app.dependencies import get_current_user
from app.models import User
from app.services.gemini_service import (
    GeminiServiceError,
    analyze_resume_with_gemini,
    generate_ai_recommendations,
    generate_skill_micro_quiz,
    grade_skill_micro_quiz,
)
from app.services.intelligence import (
    build_notifications,
    career_gaps,
    dashboard_data,
    evidenced_skill_names,
    read_user_value,
    simulate_career_matches,
)

router = APIRouter(tags=["AptiNexus"])


@router.get("/notifications")
def notifications(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return build_notifications(db, user)


@router.get("/analytics/dashboard")
def dashboard(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return dashboard_data(db, user)


@router.get("/careers")
def careers(user: User = Depends(get_current_user)):
    return CAREERS


@router.get("/careers/matches")
def career_matches(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return dashboard_data(db, user)["careers"]


@router.get("/careers/{career_id}")
def career(career_id: str, user: User = Depends(get_current_user)):
    item = next((career for career in CAREERS if career["id"] == career_id), None)
    if item is None:
        raise HTTPException(status_code=404, detail="Career not found")
    return item


@router.get("/skills")
def skills(user: User = Depends(get_current_user)):
    return SKILLS


@router.get("/resources")
def resources(user: User = Depends(get_current_user)):
    return RESOURCES


@router.get("/assessments")
def assessments(user: User = Depends(get_current_user)):
    # Never send answer keys to the browser before submission.
    return [
        {
            "id": item["id"],
            "title": item["title"],
            "skill": item["skill"],
            "questions": [
                {"q": question["q"], "options": question["options"]}
                for question in item["questions"]
            ],
        }
        for item in ASSESSMENTS
    ]


@router.post("/assessments/{assessment_id}/submit")
def submit_assessment(
    assessment_id: str,
    payload: dict,
    user: User = Depends(get_current_user),
):
    assessment = next((item for item in ASSESSMENTS if item["id"] == assessment_id), None)
    if assessment is None:
        raise HTTPException(status_code=404, detail="Assessment not found")
    answers = payload.get("answers")
    questions = assessment["questions"]
    if not isinstance(answers, list) or len(answers) != len(questions):
        raise HTTPException(status_code=422, detail="Submit one answer for every question")
    if any(type(answer) is not int or answer < 0 or answer >= len(questions[index]["options"])
           for index, answer in enumerate(answers)):
        raise HTTPException(status_code=422, detail="One or more answers are invalid")
    correct_answers = [question["answer"] for question in questions]
    score = sum(answer == correct for answer, correct in zip(answers, correct_answers))
    total = len(questions)
    return {
        "assessmentId": assessment_id,
        "score": score,
        "total": total,
        "percentage": round(100 * score / total) if total else 0,
        "correctAnswers": correct_answers,
        "feedback": (
            "Strong result. Add a project or demonstration to back it up."
            if total and score / total >= 0.75 else
            "Partial result. Revisit the topics you missed."
            if total and score / total >= 0.5 else
            "This skill needs more practice."
        ),
    }


@router.get("/skillgraph")
def skillgraph(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Build a graph from this user's saved skills, with related career paths.

    Catalog skills are recommendations only when they are not in the profile;
    they are deliberately not rendered as owned skills or achievements.
    """
    profile = read_user_value(db, user.id, "profile", {})
    sections = profile.get("sections", {}) if isinstance(profile, dict) else {}
    technical = sections.get("technical", []) if isinstance(sections, dict) else []
    acquired = {
        name.strip() for name in technical
        if isinstance(name, str) and name.strip()
    } if isinstance(technical, list) else set()
    evidence = read_user_value(db, user.id, "evidence", [])
    if isinstance(evidence, list):
        for item in evidence:
            if not isinstance(item, dict):
                continue
            name = item.get("skill") or item.get("skillName") or item.get("name")
            if isinstance(name, str) and name.strip():
                acquired.add(name.strip())

    demonstrated = evidenced_skill_names(db, user)
    catalog_by_name = {item["name"].casefold(): item for item in SKILLS}
    nodes = []
    skill_ids = {}
    for name in sorted(acquired, key=str.casefold):
        catalog = catalog_by_name.get(name.casefold(), {})
        node_id = "skill-" + "-".join(name.casefold().split())
        skill_ids[name.casefold()] = node_id
        nodes.append({
            "id": node_id,
            "label": name,
            "cat": "skill",
            "status": "Demonstrated" if name in demonstrated else "Claimed",
            "desc": catalog.get("desc", "A skill saved in your profile."),
        })

    edges = []
    for name in acquired:
        catalog = catalog_by_name.get(name.casefold(), {})
        for related in catalog.get("related", []):
            related_id = skill_ids.get(related.casefold())
            source_id = skill_ids[name.casefold()]
            if related_id and source_id != related_id:
                edge = sorted([source_id, related_id])
                if edge not in edges:
                    edges.append(edge)

    # Career nodes represent possible paths, not claims about the user's experience.
    for career in CAREERS:
        matched_ids = [
            skill_ids[required.casefold()]
            for required in career.get("required", [])
            if required.casefold() in skill_ids
        ]
        if not matched_ids:
            continue
        nodes.append({
            "id": "career-" + career["id"],
            "label": career["title"],
            "cat": "career",
            "desc": "A possible career path connected to skills in your profile.",
        })
        edges.extend([[matched_id, "career-" + career["id"]] for matched_id in matched_ids])

    return {"nodes": nodes, "edges": edges}


@router.get("/careers/{career_id}/gaps")
def gaps(career_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    result = career_gaps(db, user, career_id)
    if result is None:
        raise HTTPException(status_code=404, detail="Career not found")
    return result


@router.post("/what-if")
def what_if(payload: dict, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    extra_skills = payload.get("extraSkills", [])
    if not isinstance(extra_skills, list):
        raise HTTPException(status_code=422, detail="extraSkills must be a list")
    return simulate_career_matches(db, user, extra_skills)


@router.post("/ai/recommendations")
def ai_recommendations(
    payload: dict = Body(default={}),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    focus_career_id = payload.get("focusCareerId") if isinstance(payload, dict) else None
    custom_goal = payload.get("customGoal") if isinstance(payload, dict) else None
    try:
        return generate_ai_recommendations(
            db,
            user,
            focus_career_id=focus_career_id if isinstance(focus_career_id, str) else None,
            custom_goal=custom_goal[:300] if isinstance(custom_goal, str) else None,
        )
    except GeminiServiceError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.post("/ai/skill-quiz")
def ai_skill_quiz(
    payload: dict = Body(default={}),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    skill = payload.get("skill") if isinstance(payload, dict) else ""
    try:
        return generate_skill_micro_quiz(db, user, skill if isinstance(skill, str) else "")
    except GeminiServiceError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


@router.post("/ai/skill-quiz/submit")
def ai_skill_quiz_submit(
    payload: dict = Body(default={}),
    user: User = Depends(get_current_user),
):
    quiz_token = payload.get("quizToken") if isinstance(payload, dict) else ""
    answers = payload.get("answers") if isinstance(payload, dict) else []
    try:
        return grade_skill_micro_quiz(
            quiz_token if isinstance(quiz_token, str) else "",
            answers if isinstance(answers, list) else [],
        )
    except GeminiServiceError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


@router.post("/resume/analyze")
async def resume_analyze(
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Extract resume text and return semantic suggestions and profile corrections."""
    import io
    import re
    from docx import Document
    from pypdf import PdfReader

    filename = (file.filename or "").lower()
    if not (filename.endswith(".pdf") or filename.endswith(".docx")):
        raise HTTPException(status_code=415, detail="Upload a PDF or DOCX file")
    raw = await file.read(5 * 1024 * 1024 + 1)
    if len(raw) > 5 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Resume must be 5 MB or smaller")
    if not raw:
        raise HTTPException(status_code=400, detail="The uploaded file is empty")
    try:
        if filename.endswith(".pdf"):
            reader = PdfReader(io.BytesIO(raw))
            if reader.is_encrypted:
                raise HTTPException(status_code=422, detail="Password-protected PDFs are not supported")
            text = "\n".join(page.extract_text() or "" for page in reader.pages[:20])
        else:
            document = Document(io.BytesIO(raw))
            text = "\n".join(paragraph.text for paragraph in document.paragraphs)
            for table in document.tables:
                text += "\n" + "\n".join(" | ".join(cell.text for cell in row.cells) for row in table.rows)
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=422, detail="Could not read this document. Try another PDF or DOCX.")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    if not text:
        raise HTTPException(status_code=422, detail="No selectable text found. Scanned image-only PDFs are not supported yet.")

    try:
        return analyze_resume_with_gemini(db, user, text, file.filename or "resume")
    except GeminiServiceError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
