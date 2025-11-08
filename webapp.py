#!/usr/bin/env python3
import os, io, csv, sqlite3, base64, tempfile, datetime as dt
from typing import Optional
from fastapi import FastAPI, Request, Form, UploadFile, File
from fastapi.responses import HTMLResponse, RedirectResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from urllib.parse import urlencode

# Optional imports for OCR
try:
    from PIL import Image, ImageOps, ImageFilter
except Exception:
    Image = None

DB_PATH = os.environ.get("STUDY_DB", "study.db")

app = FastAPI()
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

def connect():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys=ON;")
    return con

def deck_list(con):
    return [r["name"] for r in con.execute("SELECT name FROM decks ORDER BY name")]

def deck_stats(con):
    q = """
    SELECT d.id, d.name,
           COUNT(c.id) AS total,
           SUM(CASE WHEN c.suspended=0 AND DATETIME(c.due)<=DATETIME('now') THEN 1 ELSE 0 END) AS due
    FROM decks d
    LEFT JOIN cards c ON c.deck_id = d.id
    GROUP BY d.id, d.name
    ORDER BY d.name
    """
    return [dict(r) for r in con.execute(q)]

def ensure_deck(con, name: str) -> int:
    r = con.execute("SELECT id FROM decks WHERE name=?", (name,)).fetchone()
    if r: return int(r["id"])
    with con:
        con.execute("INSERT INTO decks(name) VALUES(?)", (name,))
    return int(con.execute("SELECT id FROM decks WHERE name=?", (name,)).fetchone()["id"])

def due_count(con, deck=None, tag=None):
    q = "SELECT COUNT(*) FROM cards c JOIN decks d ON c.deck_id=d.id WHERE c.suspended=0 AND DATETIME(c.due)<=DATETIME('now')"
    params = []
    if deck:
        q += " AND d.name=?"; params.append(deck)
    if tag:
        q += " AND c.tags LIKE ?"; params.append(f"%{tag}%")
    return int(con.execute(q, params).fetchone()[0])

def pool_count(con, deck=None, tag=None):
    q = "SELECT COUNT(*) FROM cards c JOIN decks d ON c.deck_id=d.id WHERE c.suspended=0"
    params = []
    if deck:
        q += " AND d.name=?"; params.append(deck)
    if tag:
        q += " AND c.tags LIKE ?"; params.append(f"%{tag}%")
    return int(con.execute(q, params).fetchone()[0])

def next_due_card(con, deck=None, tag=None):
    q = """SELECT c.*, d.name as deck_name
           FROM cards c JOIN decks d ON c.deck_id=d.id
           WHERE c.suspended=0 AND DATETIME(c.due)<=DATETIME('now')"""
    params = []
    if deck:
        q += " AND d.name=?"; params.append(deck)
    if tag:
        q += " AND c.tags LIKE ?"; params.append(f"%{tag}%")
    q += " ORDER BY DATETIME(c.due) ASC, c.id ASC LIMIT 1"
    return con.execute(q, params).fetchone()

def random_card(con, deck=None, tag=None):
    q = """SELECT c.*, d.name as deck_name
           FROM cards c JOIN decks d ON c.deck_id=d.id
           WHERE c.suspended=0"""
    params = []
    if deck:
        q += " AND d.name=?"; params.append(deck)
    if tag:
        q += " AND c.tags LIKE ?"; params.append(f"%{tag}%")
    q += " ORDER BY RANDOM() LIMIT 1"
    return con.execute(q, params).fetchone()

@app.get("/", response_class=HTMLResponse)
def home(request: Request, deck: str|None=None, tag: str|None=None):
    con = connect()
    decks = deck_list(con)
    counts = {"due": due_count(con, deck, tag), "pool": pool_count(con, deck, tag)}
    return templates.TemplateResponse("home.html", {
        "request": request, "decks": decks, "deck": deck, "tag": tag, "counts": counts
    })

@app.get("/review", response_class=HTMLResponse)
def review(request: Request, deck: str|None=None, tag: str|None=None):
    con = connect()
    decks = deck_list(con)
    card = next_due_card(con, deck, tag)
    return templates.TemplateResponse("card.html", {
        "request": request, "card": card, "decks": decks, "deck": deck, "tag": tag,
        "mode": "review", "pill_label": "Due", "pill_value": due_count(con, deck, tag)
    })

@app.get("/quiz", response_class=HTMLResponse)
def quiz(request: Request, deck: str|None=None, tag: str|None=None, _: str|None=None):
    con = connect()
    decks = deck_list(con)
    card = random_card(con, deck, tag)
    return templates.TemplateResponse("card.html", {
        "request": request, "card": card, "decks": decks, "deck": deck, "tag": tag,
        "mode": "quiz", "pill_label": "Pool", "pill_value": pool_count(con, deck, tag)
    })

# ---------- Import ----------
@app.get("/import", response_class=HTMLResponse)
def import_form(request: Request):
    con = connect()
    return templates.TemplateResponse("import.html", {
        "request": request,
        "decks": deck_list(con)
    })

@app.post("/import", response_class=HTMLResponse)
async def import_csv(
    request: Request,
    file: UploadFile = File(...),
    deck_select: str = Form(""),
    deck_new: str = Form(""),
    mark_due_today: int = Form(1),
    default_tags: str = Form("Imported")
):
    import io, csv, datetime as dt
    con = connect()
    deck_name = deck_new.strip() or deck_select.strip() or "Imported"
    deck_id = ensure_deck(con, deck_name)

    raw = await file.read()
    text = raw.decode("utf-8-sig", errors="replace")
    reader = csv.DictReader(io.StringIO(text))
    header_lower = [c.strip().lower() for c in (reader.fieldnames or [])]
    required = {"front","back"}
    missing_cols = required - set(header_lower)
    if missing_cols:
        return templates.TemplateResponse("import_result.html", {
            "request": request, "ok": False,
            "message": f"CSV missing required columns: {', '.join(sorted(missing_cols))}",
            "deck": deck_name, "count": 0
        })

    inserted = 0
    now = dt.datetime.now()
    due_str = now.isoformat(sep=" ") if mark_due_today else (now + dt.timedelta(days=1)).isoformat(sep=" ")
    with con:
        for row in reader:
            def g(key):
                for k in (key, key.capitalize(), key.upper()):
                    if k in row and row[k] is not None: return row[k]
                return ""
            front = (g("front") or "").strip()
            back  = (g("back") or "").strip()
            if not front or not back:
                continue
            card_type = (g("card_type") or "basic").strip().lower() or "basic"
            tags = (g("tags") or default_tags).strip()
            img = (g("image_path") or "").strip() or None
            prov = (g("provenance") or "").strip() or None
            notes = (g("notes") or "").strip() or None
            ease, interval, reps, lapses, suspended = 2.5, 0, 0, 0, 0
            con.execute(
                """INSERT INTO cards (deck_id, front, back, card_type, tags, image_path, provenance, notes,
                                       ease, interval, reps, lapses, due, suspended, created_at, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,DATETIME('now'),DATETIME('now'))""",
                (deck_id, front, back, card_type, tags, img, prov, notes,
                 ease, interval, reps, lapses, due_str, suspended)
            )
            inserted += 1

    return templates.TemplateResponse("import_result.html", {
        "request": request, "ok": True,
        "message": f"Imported {inserted} cards into deck '{deck_name}'.",
        "deck": deck_name, "count": inserted
    })

# ---------- New Card editor ----------
@app.get("/cards/new", response_class=HTMLResponse)
def new_card_form(request: Request):
    con = connect()
    return templates.TemplateResponse("new_card.html", {
        "request": request, "decks": deck_list(con)
    })

@app.post("/cards/create", response_class=HTMLResponse)
def create_card(
    request: Request,
    deck_select: str = Form(""),
    deck_new: str = Form(""),
    front: str = Form(...),
    back: str = Form(...),
    tags: str = Form(""),
    card_type: str = Form("basic"),
    mark_due_today: int = Form(1)
):
    front = (front or "").strip()
    back  = (back or "").strip()
    if not front or not back:
        return templates.TemplateResponse("new_result.html", {
            "request": request, "ok": False, "message": "Front and Back cannot be empty."
        })

    con = connect()
    deck_name = (deck_new or deck_select or "My Deck").strip()
    deck_id = ensure_deck(con, deck_name)
    now = dt.datetime.now()
    due_str = now.isoformat(sep=" ") if mark_due_today else (now + dt.timedelta(days=1)).isoformat(sep=" ")
    ease, interval, reps, lapses, suspended = 2.5, 0, 0, 0, 0

    with con:
        con.execute(
            """INSERT INTO cards (deck_id, front, back, card_type, tags, image_path, provenance, notes,
                                   ease, interval, reps, lapses, due, suspended, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,DATETIME('now'),DATETIME('now'))""",
            (deck_id, front, back, card_type, (tags or "").strip(), None, None, None,
             ease, interval, reps, lapses, due_str, suspended)
        )
    return templates.TemplateResponse("new_result.html", {
        "request": request, "ok": True, "message": f"Card saved to '{deck_name}'."
    })

# ---------- Decks (list + delete) ----------
@app.get("/decks", response_class=HTMLResponse)
def decks_page(request: Request):
    con = connect()
    stats = deck_stats(con)
    return templates.TemplateResponse("decks.html", {"request": request, "stats": stats})

@app.post("/decks/delete", response_class=HTMLResponse)
def delete_deck(request: Request, deck_name: str = Form(...), confirm: str = Form("")):
    deck_name = deck_name.strip()
    confirm = confirm.strip()
    con = connect()
    r = con.execute("SELECT id FROM decks WHERE name=?", (deck_name,)).fetchone()
    if not r:
        return templates.TemplateResponse("decks_result.html", {"request": request, "ok": False, "message": f"Deck '{deck_name}' not found."})
    if confirm != deck_name:
        return templates.TemplateResponse("decks_result.html", {"request": request, "ok": False, "message": "Confirmation text does not match deck name. No changes made."})
    deck_id = int(r["id"])
    with con:
        con.execute("DELETE FROM cards WHERE deck_id=?", (deck_id,))
        con.execute("DELETE FROM decks WHERE id=?", (deck_id,))
    return templates.TemplateResponse("decks_result.html", {"request": request, "ok": True, "message": f"Deleted deck '{deck_name}' and its cards."})

# ---------- Rate ----------
@app.post("/rate/{card_id}")
def rate(card_id: int, quality: int = Form(...), confidence: Optional[int] = Form(None), deck: str = Form(""), tag: str = Form("")):
    con = connect()
    r = con.execute("SELECT * FROM cards WHERE id=?", (card_id,)).fetchone()
    if not r:
        return RedirectResponse("/", status_code=302)
    def sm2(ease, interval, reps, q):
        q = max(0, min(5, q))
        if q < 3:
            reps = 0; interval = 1
        else:
            if reps==0: interval=1
            elif reps==1: interval=6
            else: interval=int(round(interval*ease))
            reps += 1
            ease = ease + (0.1 - (5-q)*(0.08 + (5-q)*0.02))
            if ease < 1.3: ease = 1.3
        return ease, interval, reps
    ease, interval, reps = r["ease"], r["interval"], r["reps"]
    lapses = r["lapses"]
    if quality < 3: lapses += 1
    ease, interval, reps = sm2(ease, interval, reps, quality)
    due = (dt.datetime.now() + dt.timedelta(days=interval)).isoformat(sep=" ")
    with con:
        con.execute("""UPDATE cards SET ease=?, interval=?, reps=?, lapses=?, due=?,
                       last_reviewed=DATETIME('now'), updated_at=DATETIME('now') WHERE id=?""",
                    (ease, interval, reps, lapses, due, card_id))
        con.execute("INSERT INTO reviews(card_id,quality,confidence) VALUES(?,?,?)",(card_id, quality, confidence))
    query = {}
    if deck: query["deck"] = deck
    if tag: query["tag"] = tag
    qs = "?" + urlencode(query) if query else ""
    return RedirectResponse("/review" + qs, status_code=303)

# ---------- OCR: Offline handwriting/typeset math -> LaTeX ----------
def _predict_latex_with_module(img_path: str) -> str:
    # Try native Python module first
    try:
        from pix2tex.cli import LatexOCR  # type: ignore
        from PIL import Image as PILImage  # ensure PIL is present
        model = LatexOCR()
        im = PILImage.open(img_path).convert('RGB')
        return model(im)
    except Exception as e:
        raise RuntimeError(f"pix2tex module path failed: {e}")

def _predict_latex_with_cli(img_path: str) -> str:
    # Fallback to CLI if available
    import subprocess, shlex
    try:
        cmd = f"pix2tex \"{img_path}\""
        out = subprocess.check_output(cmd, shell=True, stderr=subprocess.STDOUT, text=True, timeout=60)
        return out.strip()
    except Exception as e:
        raise RuntimeError(f"pix2tex CLI failed: {e}")

def _preprocess_image_to_png(raw_bytes: bytes) -> str:
    # Save to temp PNG and do light preprocessing to help OCR
    if Image is None:
        # No PIL, just save as-is
        fd, path = tempfile.mkstemp(suffix=".png")
        with os.fdopen(fd, "wb") as f: f.write(raw_bytes)
        return path
    img = Image.open(io.BytesIO(raw_bytes)).convert("L")
    # simple autocontrast + slight sharpen, pad
    img = ImageOps.autocontrast(img, cutoff=2)
    img = img.filter(ImageFilter.SHARPEN)
    # pad 16px to avoid clipping
    pad = 16
    w, h = img.size
    canvas = Image.new("L", (w+2*pad, h+2*pad), 255)
    canvas.paste(img, (pad, pad))
    fd, path = tempfile.mkstemp(suffix=".png")
    with os.fdopen(fd, "wb") as f:
        canvas.save(f, format="PNG")
    return path

@app.post("/ocr/latex")
async def ocr_latex(image: UploadFile = File(...)):
    try:
        raw = await image.read()
        img_path = _preprocess_image_to_png(raw)
        # Try module, then CLI
        try:
            latex = _predict_latex_with_module(img_path)
        except Exception as e1:
            try:
                latex = _predict_latex_with_cli(img_path)
            except Exception as e2:
                msg = "pix2tex not available. Install it with:\n  pip install pix2tex torch torchvision\n(Use CPU wheels if you have no GPU)."
                return JSONResponse({"ok": False, "error": msg, "detail": [str(e1), str(e2)]}, status_code=501)
        # Clean up latex a bit
        latex = latex.strip().replace("\n", " ").strip()
        return {"ok": True, "latex": latex}
    except Exception as e:
        return JSONResponse({"ok": False, "error": f"OCR failed: {e}"}, status_code=500)
