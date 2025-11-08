#!/usr/bin/env python3
import os, io, csv, json, sqlite3, datetime as dt, secrets
from typing import Optional
from fastapi import FastAPI, Request, Form, UploadFile, File, Body, HTTPException
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.middleware.cors import CORSMiddleware
from urllib.parse import urlencode

DB_PATH = os.environ.get("STUDY_DB", "study.db")

app = FastAPI()
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"]
)

def connect():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys=ON;")
    return con

DRAW_SCHEMA = """
CREATE TABLE IF NOT EXISTS draw_sets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at DATETIME DEFAULT (DATETIME('now')),
    updated_at DATETIME DEFAULT (DATETIME('now'))
);
CREATE TABLE IF NOT EXISTS draw_cards (
    set_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    card_json TEXT NOT NULL,
    updated_at DATETIME DEFAULT (DATETIME('now')),
    PRIMARY KEY (set_id, position),
    FOREIGN KEY(set_id) REFERENCES draw_sets(id) ON DELETE CASCADE
);
"""


def ensure_draw_schema():
    con = connect()
    try:
        with con:
            con.executescript(DRAW_SCHEMA)
            count = con.execute("SELECT COUNT(*) AS c FROM draw_sets").fetchone()["c"]
            if count == 0:
                ensure_draw_set(con, "default", "Default", with_default=True)
    finally:
        con.close()


ensure_draw_schema()


def draw_set_row_to_dict(row):
    return {
        "id": row["id"],
        "name": row["name"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def empty_side():
    return {"strokes": [], "images": []}


def empty_card():
    return {
        "front": empty_side(),
        "back": empty_side(),
        "createdAt": int(dt.datetime.now().timestamp() * 1000),
    }


def load_draw_deck(con, set_id: str):
    rows = con.execute(
        "SELECT card_json FROM draw_cards WHERE set_id=? ORDER BY position",
        (set_id,),
    ).fetchall()
    deck = []
    for row in rows:
        payload = row["card_json"]
        if payload is None:
            continue
        try:
            deck.append(json.loads(payload))
        except (ValueError, TypeError):
            continue
    return deck


def save_draw_deck(con, set_id: str, deck):
    serialised = []
    for card in deck or []:
        try:
            serialised.append(json.dumps(card))
        except (TypeError, ValueError):
            continue
    with con:
        con.execute("DELETE FROM draw_cards WHERE set_id=?", (set_id,))
        for idx, payload in enumerate(serialised):
            con.execute(
                """INSERT INTO draw_cards(set_id, position, card_json, updated_at)
                       VALUES(?,?,?,DATETIME('now'))""",
                (set_id, idx, payload),
            )
        con.execute(
            "UPDATE draw_sets SET updated_at=DATETIME('now') WHERE id=?",
            (set_id,),
        )


def ensure_draw_set(con, set_id: str | None, name: str | None = None, *, with_default: bool = False):
    if set_id:
        row = con.execute("SELECT id, name FROM draw_sets WHERE id=?", (set_id,)).fetchone()
        if row:
            return row["id"], row["name"]
    new_id = set_id or f"set_{secrets.token_hex(4)}"
    new_name = (name or "New Set").strip() or "New Set"
    with con:
        con.execute(
            "INSERT INTO draw_sets(id, name, created_at, updated_at) VALUES(?,?,DATETIME('now'),DATETIME('now'))",
            (new_id, new_name),
        )
    if with_default:
        save_draw_deck(con, new_id, [empty_card()])
    return new_id, new_name


def ensure_default_draw(con):
    count = con.execute("SELECT COUNT(*) AS c FROM draw_sets").fetchone()["c"]
    if count == 0:
        ensure_draw_set(con, "default", "Default", with_default=True)


@app.get("/api/draw/sets")
def api_list_draw_sets():
    con = connect()
    try:
        ensure_default_draw(con)
        rows = con.execute(
            "SELECT id, name, created_at, updated_at FROM draw_sets ORDER BY created_at"
        ).fetchall()
        return {"sets": [draw_set_row_to_dict(r) for r in rows]}
    finally:
        con.close()


@app.post("/api/draw/sets")
def api_create_draw_set(payload: dict = Body(...)):
    name = (payload.get("name") or "New Set").strip() or "New Set"
    requested_id = payload.get("id")
    con = connect()
    try:
        if requested_id:
            existing = con.execute(
                "SELECT id FROM draw_sets WHERE id=?", (requested_id,)
            ).fetchone()
            if existing:
                raise HTTPException(status_code=409, detail="Set id already exists")
        new_id, new_name = ensure_draw_set(
            con, requested_id, name, with_default=True
        )
        deck_payload = payload.get("deck")
        if isinstance(deck_payload, list) and deck_payload:
            save_draw_deck(con, new_id, deck_payload)
        row = con.execute(
            "SELECT id, name, created_at, updated_at FROM draw_sets WHERE id=?",
            (new_id,),
        ).fetchone()
        return draw_set_row_to_dict(row)
    finally:
        con.close()


@app.get("/api/draw/sets/{set_id}")
def api_get_draw_set(set_id: str):
    con = connect()
    try:
        row = con.execute(
            "SELECT id, name, created_at, updated_at FROM draw_sets WHERE id=?",
            (set_id,),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Set not found")
        deck = load_draw_deck(con, set_id)
        data = draw_set_row_to_dict(row)
        data["deckSize"] = len(deck)
        return data
    finally:
        con.close()


@app.put("/api/draw/sets/{set_id}")
def api_update_draw_set(set_id: str, payload: dict = Body(...)):
    name = payload.get("name")
    if not isinstance(name, str) or not name.strip():
        raise HTTPException(status_code=400, detail="Name is required")
    name = name.strip()
    con = connect()
    try:
        with con:
            res = con.execute(
                "UPDATE draw_sets SET name=?, updated_at=DATETIME('now') WHERE id=?",
                (name, set_id),
            )
        if res.rowcount == 0:
            raise HTTPException(status_code=404, detail="Set not found")
        row = con.execute(
            "SELECT id, name, created_at, updated_at FROM draw_sets WHERE id=?",
            (set_id,),
        ).fetchone()
        return draw_set_row_to_dict(row)
    finally:
        con.close()


@app.delete("/api/draw/sets/{set_id}")
def api_delete_draw_set(set_id: str):
    con = connect()
    try:
        with con:
            res = con.execute("DELETE FROM draw_sets WHERE id=?", (set_id,))
        if res.rowcount == 0:
            raise HTTPException(status_code=404, detail="Set not found")
        return {"ok": True}
    finally:
        con.close()


@app.get("/api/draw/sets/{set_id}/deck")
def api_get_draw_deck(set_id: str):
    con = connect()
    try:
        row = con.execute("SELECT id FROM draw_sets WHERE id=?", (set_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Set not found")
        deck = load_draw_deck(con, set_id)
        return {"deck": deck}
    finally:
        con.close()


@app.put("/api/draw/sets/{set_id}/deck")
def api_put_draw_deck(set_id: str, payload: dict = Body(...)):
    deck_payload = payload.get("deck")
    if deck_payload is None:
        raise HTTPException(status_code=400, detail="Deck payload required")
    if not isinstance(deck_payload, list):
        raise HTTPException(status_code=400, detail="Deck must be a list")
    con = connect()
    try:
        ensure_draw_set(con, set_id, payload.get("name"))
        save_draw_deck(con, set_id, deck_payload)
        deck = load_draw_deck(con, set_id)
        return {"deckSize": len(deck)}
    finally:
        con.close()


@app.post("/api/draw/sync")
def api_sync_draw_sets(payload: dict = Body(...)):
    sets_payload = payload.get("sets")
    if not isinstance(sets_payload, list):
        raise HTTPException(status_code=400, detail="Sets payload required")
    con = connect()
    try:
        ensure_default_draw(con)
        synced = []
        for item in sets_payload:
            if not isinstance(item, dict):
                continue
            set_id = item.get("id")
            if not isinstance(set_id, str) or not set_id.strip():
                continue
            name = (item.get("name") or "New Set").strip() or "New Set"
            deck = item.get("deck") if isinstance(item.get("deck"), list) else []
            ensure_draw_set(con, set_id, name, with_default=not deck)
            if deck:
                save_draw_deck(con, set_id, deck)
            with con:
                con.execute(
                    "UPDATE draw_sets SET name=?, updated_at=DATETIME('now') WHERE id=?",
                    (name, set_id),
                )
            row = con.execute(
                "SELECT id, name, created_at, updated_at FROM draw_sets WHERE id=?",
                (set_id,),
            ).fetchone()
            if row:
                synced.append(draw_set_row_to_dict(row))
        return {"sets": synced}
    finally:
        con.close()

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
