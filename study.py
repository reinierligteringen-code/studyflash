#!/usr/bin/env python3
import sys, os, sqlite3, datetime as dt, csv, json, random, textwrap, shutil, zipfile
from collections import defaultdict

DB_PATH = os.environ.get("STUDY_DB", "study.db")

SCHEMA = """
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS decks(
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL
);
CREATE TABLE IF NOT EXISTS cards(
  id INTEGER PRIMARY KEY,
  deck_id INTEGER NOT NULL,
  front TEXT NOT NULL,
  back TEXT NOT NULL,
  tags TEXT DEFAULT '',
  card_type TEXT DEFAULT 'basic',
  options TEXT DEFAULT NULL,
  image_path TEXT DEFAULT NULL,
  provenance TEXT DEFAULT NULL,
  notes TEXT DEFAULT NULL,
  ease REAL DEFAULT 2.5,
  interval INTEGER DEFAULT 0,
  reps INTEGER DEFAULT 0,
  lapses INTEGER DEFAULT 0,
  learning_step_index INTEGER DEFAULT 0,
  due DATETIME DEFAULT (DATETIME('now')),
  last_reviewed DATETIME,
  suspended INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT (DATETIME('now')),
  updated_at DATETIME DEFAULT (DATETIME('now')),
  FOREIGN KEY(deck_id) REFERENCES decks(id)
);
CREATE INDEX IF NOT EXISTS idx_cards_due ON cards(due);
CREATE INDEX IF NOT EXISTS idx_cards_tags ON cards(tags);

CREATE TABLE IF NOT EXISTS reviews(
  id INTEGER PRIMARY KEY,
  card_id INTEGER NOT NULL,
  reviewed_at DATETIME DEFAULT (DATETIME('now')),
  quality INTEGER NOT NULL,
  confidence INTEGER,
  duration_sec INTEGER,
  FOREIGN KEY(card_id) REFERENCES cards(id)
);

CREATE TABLE IF NOT EXISTS config(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"""

DEFAULT_CONFIG = {
  "new_cap": 20,
  "learning_steps": "[10, 1440]",
  "leech_threshold": 8
}

HELP = """Study Suite CLI
Commands:
  init
  config [--show | --set key=value ...]
  deck "Name"
  add [Deck Name]
  import file.csv [Deck Name]
  export out.csv [--deck "Name"]
  review [--limit N] [--deck "Name"] [--tags t1,t2] [--interleave tag] [--include-new yes|no]
  quiz [--limit N] [--deck "Name"] [--tags t1,t2]
  stats
  forecast [days]
  ics out.ics [days]
  staleness [--days D]
  suspend [card_id] | unsuspend [card_id]
  backup out.zip | restore in.zip
"""

def connect():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys=ON;")
    return con

def init_db():
    con = connect()
    with con:
        for stmt in SCHEMA.strip().split(";"):
            s = stmt.strip()
            if s:
                con.execute(s)
        for k,v in DEFAULT_CONFIG.items():
            con.execute("INSERT OR IGNORE INTO config(key,value) VALUES(?,?)",(k,str(v)))
    print(f"Initialized DB at {DB_PATH}")

def get_config(con):
    d = {row["key"]: row["value"] for row in con.execute("SELECT key,value FROM config")}
    d.setdefault("new_cap", str(DEFAULT_CONFIG["new_cap"]))
    d.setdefault("learning_steps", DEFAULT_CONFIG["learning_steps"])
    d.setdefault("leech_threshold", str(DEFAULT_CONFIG["leech_threshold"]))
    return d

def set_config(con, updates):
    with con:
        for k,v in updates.items():
            con.execute("INSERT INTO config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",(k,str(v)))
    print("Updated config.")

def ensure_deck(con, name):
    cur = con.execute("SELECT id FROM decks WHERE name=?",(name,))
    r = cur.fetchone()
    if r: return r["id"]
    cur = con.execute("INSERT INTO decks(name) VALUES(?)",(name,))
    return cur.lastrowid

def parse_tags(s):
    if not s: return []
    return [t.strip() for t in s.split(",") if t.strip()]

def sm2_update(ease, interval, reps, quality):
    q = max(0, min(5, quality))
    if q < 3:
        reps = 0
        interval = 1
    else:
        if reps == 0:
            interval = 1
        elif reps == 1:
            interval = 6
        else:
            interval = int(round(interval * ease))
        reps += 1
        ease = ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02))
        if ease < 1.3: ease = 1.3
    return ease, interval, reps

def get_learning_steps(con):
    cfg = get_config(con)
    try:
        steps = json.loads(cfg.get("learning_steps","[10,1440]"))
        steps = [int(x) for x in steps]
    except Exception:
        steps = [10,1440]
    return steps

def cmd_config(args):
    con = connect()
    if "--show" in args or not args:
        print(json.dumps(get_config(con), indent=2)); return
    if "--set" in args:
        idx = args.index("--set"); updates={}
        for item in args[idx+1:]:
            if "=" in item:
                k,v=item.split("=",1); updates[k]=v
        set_config(con, updates); return
    print("Usage: config --show | --set key=value ...")

def cmd_deck(args):
    if not args: print('Usage: deck "Name"'); return
    con = connect()
    with con: deck_id = ensure_deck(con, " ".join(args))
    print(f"Deck ready: {' '.join(args)} (id={deck_id})")

def cmd_add(args):
    deck = " ".join(args) if args else input("Deck name: ").strip() or "Default"
    front = input("Front / Question: ").strip()
    back = input("Back / Answer: ").strip()
    tags = input("Tags (comma-separated): ").strip()
    card_type = input("Card type (basic|cloze|mcq|image) [basic]: ").strip() or "basic"
    options = None; image_path=None
    if card_type=="mcq":
        print('Enter MCQ options JSON; mark correct with asterisk e.g. ["A*","B","C","D"]')
        options = input("Options JSON: ").strip() or "[]"
    if card_type=="image":
        image_path = input("Image file path: ").strip() or None
    provenance = input("Provenance (source/page): ").strip()
    notes = input("Notes: ").strip()
    con = connect()
    with con:
        deck_id = ensure_deck(con, deck)
        con.execute("""INSERT INTO cards(deck_id,front,back,tags,card_type,options,image_path,provenance,notes)
                       VALUES(?,?,?,?,?,?,?,?,?)""", (deck_id, front, back, tags, card_type, options, image_path, provenance, notes))
    print("Card added.")

def cmd_import(args):
    if not args: print("Usage: import file.csv [Deck Name]"); return
    path = args[0]; deck=" ".join(args[1:]) if len(args)>1 else "Imported"
    con = connect()
    with con:
        deck_id = ensure_deck(con, deck)
        with open(path, newline='', encoding='utf-8') as f:
            r = csv.DictReader(f); count=0
            for row in r:
                front=row.get("front",""); back=row.get("back",""); tags=row.get("tags","")
                card_type=row.get("card_type","basic"); options=row.get("options"); image_path=row.get("image_path")
                provenance=row.get("provenance"); notes=row.get("notes")
                if not (front and back) and card_type!="image": continue
                con.execute("""INSERT INTO cards(deck_id,front,back,tags,card_type,options,image_path,provenance,notes)
                               VALUES(?,?,?,?,?,?,?,?,?)""", (deck_id, front, back, tags, card_type, options, image_path, provenance, notes)); count+=1
    print(f"Imported {count} cards into '{deck}'.")

def cmd_export(args):
    if not args: print('Usage: export out.csv [--deck "Name"]'); return
    out=args[0]; deck=None
    if "--deck" in args:
        i=args.index("--deck"); 
        if i+1<len(args): deck=args[i+1]
    con = connect()
    q="SELECT c.*, d.name as deck_name FROM cards c JOIN decks d ON c.deck_id=d.id"
    params=[]
    if deck: q+=" WHERE d.name=?"; params.append(deck)
    rows = con.execute(q, params).fetchall()
    with open(out,"w",newline='',encoding='utf-8') as f:
        w=csv.writer(f)
        w.writerow(["deck","front","back","tags","card_type","options","image_path","provenance","notes","ease","interval","reps","lapses","due","suspended"])
        for r in rows:
            w.writerow([r["deck_name"], r["front"], r["back"], r["tags"], r["card_type"], r["options"], r["image_path"], r["provenance"], r["notes"], r["ease"], r["interval"], r["reps"], r["lapses"], r["due"], r["suspended"]])
    print(f"Wrote {len(rows)} cards to {out}")

def fetch_due_cards(con, limit, deck=None, tags=None, interleave=None, include_new=True):
    clauses=["c.suspended=0"]; params=[]
    clauses.append("DATETIME(c.due) <= DATETIME('now')")
    if deck: clauses.append("d.name=?"); params.append(deck)
    if tags:
        for t in tags: clauses.append("c.tags LIKE ?"); params.append(f"%{t}%")
    where = " WHERE " + " AND ".join(clauses)
    q=f"""SELECT c.*, d.name as deck_name FROM cards c JOIN decks d ON c.deck_id=d.id{where}
          ORDER BY DATETIME(c.due) ASC, c.id ASC LIMIT ?"""
    params.append(limit*10 if interleave else limit)
    rows=con.execute(q, params).fetchall()
    cfg=get_config(con); new_cap=int(cfg.get("new_cap",20))
    selected=[]; new_count=0
    for r in rows:
        is_new=(r["reps"]==0 and include_new)
        if is_new:
            if new_count>=new_cap: continue
            new_count+=1
        selected.append(r)
    if interleave=="tag":
        from collections import defaultdict
        buckets=defaultdict(list)
        for r in selected:
            t=(parse_tags(r["tags"]) or [""])[0]; buckets[t].append(r)
        order=[]
        while any(buckets.values()) and len(order)<limit:
            for k in list(buckets.keys()):
                if buckets[k]: order.append(buckets[k].pop(0))
                if len(order)>=limit: break
        selected=order
    else:
        selected=selected[:limit]
    return selected

def present_card(r):
    print("="*70)
    print(f"[Deck] {r['deck_name']} | [Tags] {r['tags']} | [Type] {r['card_type']} | [Due] {r['due']}")
    print("-"*70)
    front=r["front"]
    if r["card_type"]=="cloze":
        masked=front.replace("{{c1::","[[[").replace("}}","]]]")
        print(textwrap.fill(masked, width=80))
    elif r["card_type"]=="image":
        print(f"(image) {r['image_path'] or ''}")
    else:
        print(textwrap.fill(front, width=80))

def update_schedule(con, r, quality, confidence=None, duration_sec=None):
    now=dt.datetime.now()
    ease=r["ease"]; interval=r["interval"]; reps=r["reps"]; lapses=r["lapses"]
    steps=json.loads(get_config(con).get("learning_steps","[10,1440]"))
    step_idx=r["learning_step_index"]
    in_learning = (reps==0 or step_idx < len(steps))
    if in_learning:
        if quality>=3:
            step_idx+=1
            if step_idx>=len(steps):
                step_idx=len(steps)
                ease,interval,reps=sm2_update(ease,interval,reps,quality)
                due=now + dt.timedelta(days=interval)
            else:
                due=now + dt.timedelta(minutes=int(steps[step_idx-1]))
        else:
            step_idx=0
            due=now + dt.timedelta(minutes=int(steps[0]))
            lapses+=1
    else:
        if quality<3: lapses+=1
        ease,interval,reps=sm2_update(ease,interval,reps,quality)
        due=now + dt.timedelta(days=interval)
    leech_threshold=int(get_config(con).get("leech_threshold",8))
    suspended=r["suspended"]
    if lapses>=leech_threshold: suspended=1
    with con:
        con.execute("""UPDATE cards SET ease=?, interval=?, reps=?, lapses=?, learning_step_index=?, 
                       due=?, last_reviewed=DATETIME('now'), updated_at=DATETIME('now'), suspended=? WHERE id=?""",
                    (ease, interval, reps, lapses, step_idx, due.isoformat(sep=" "), suspended, r["id"]))
        con.execute("INSERT INTO reviews(card_id,quality,confidence,duration_sec) VALUES(?,?,?,?)",
                    (r["id"], int(quality), int(confidence) if confidence else None, int(duration_sec) if duration_sec else None))
    return suspended

def cmd_review(args):
    limit=999999; deck=None; tags=None; interleave=None; include_new=True
    i=0
    while i<len(args):
        a=args[i]
        if a=="--limit" and i+1<len(args): limit=int(args[i+1]); i+=2; continue
        if a=="--deck" and i+1<len(args): deck=args[i+1]; i+=2; continue
        if a=="--tags" and i+1<len(args): tags=[t.strip() for t in args[i+1].split(",")]; i+=2; continue
        if a=="--interleave" and i+1<len(args): interleave=args[i+1]; i+=2; continue
        if a=="--include-new" and i+1<len(args): include_new=args[i+1].lower()!="no"; i+=2; continue
        i+=1
    con=connect()
    due_rows=fetch_due_cards(con, limit, deck, tags, interleave, include_new)
    if not due_rows: print("No cards due. 🎉"); return
    print(f"Reviewing {len(due_rows)} card(s). Rate 1=Again, 2=Hard, 3=Good, 4=Easy. 'q' to stop.")
    for r in due_rows:
        present_card(r)
        input("\nPress Enter for answer...")
        print("\nAnswer:\n"); print(textwrap.fill(r["back"], width=80))
        t0=dt.datetime.now()
        while True:
            s=input("\nQuality (1/2/3/4 or q): ").strip().lower()
            if s=='q': print("Session ended."); return
            if s in ('1','2','3','4'):
                conf=input("Confidence 1-5 (optional): ").strip()
                try: conf_i=int(conf) if conf else None
                except: conf_i=None
                duration=(dt.datetime.now()-t0).total_seconds()
                suspended=update_schedule(con, r, int(s), confidence=conf_i, duration_sec=duration)
                if suspended: print("⚠️ Leech threshold reached — card suspended.")
                break
            else:
                print("Enter 1/2/3/4 or q.")

def cmd_quiz(args):
    limit=20; deck=None; tags=None
    i=0
    while i<len(args):
        a=args[i]
        if a=="--limit" and i+1<len(args): limit=int(args[i+1]); i+=2; continue
        if a=="--deck" and i+1<len(args): deck=args[i+1]; i+=2; continue
        if a=="--tags" and i+1<len(args): tags=[t.strip() for t in args[i+1].split(",")]; i+=2; continue
        i+=1
    con=connect()
    q="SELECT c.*, d.name as deck_name FROM cards c JOIN decks d ON c.deck_id=d.id WHERE c.suspended=0"
    params=[]
    if deck: q+=" AND d.name=?"; params.append(deck)
    if tags:
        for t in tags: q+=" AND c.tags LIKE ?"; params.append(f"%{t}%")
    q+=" ORDER BY RANDOM() LIMIT ?"; params.append(limit)
    rows=con.execute(q, params).fetchall()
    print(f"Quiz: {len(rows)} random card(s). No scheduling changes.\n")
    for r in rows:
        present_card(r)
        input("\nPress Enter for answer...")
        print("\nAnswer:\n"); print(textwrap.fill(r["back"], width=80))
        input("\n(Enter to continue)")

def cmd_stats(args):
    con=connect()
    total=con.execute("SELECT COUNT(*) FROM cards").fetchone()[0]
    due=con.execute("SELECT COUNT(*) FROM cards WHERE suspended=0 AND DATETIME(due)<=DATETIME('now')").fetchone()[0]
    new_cards=con.execute("SELECT COUNT(*) FROM cards WHERE reps=0").fetchone()[0]
    print(f"Total: {total}\nDue now: {due}\nNew (unseen): {new_cards}")
    print("\nPer tag (due/total):")
    rows=con.execute("""SELECT trim(value) tag,
                               SUM(CASE WHEN DATETIME(due)<=DATETIME('now') AND suspended=0 THEN 1 ELSE 0 END) as due,
                               COUNT(*) as total
                        FROM (
                          SELECT id, due, suspended, TRIM(value) as value FROM cards, 
                                 json_each('[' || REPLACE(REPLACE(tags, ',', '","'), ' ', '') || ']')
                        )
                        GROUP BY tag ORDER BY total DESC, tag
                     """).fetchall()
    for r in rows:
        t=r["tag"]
        if t: print(f"  - {t}: {r['due']}/{r['total']}")
    lapsers=con.execute("SELECT front,lapses FROM cards WHERE lapses>0 ORDER BY lapses DESC, id DESC LIMIT 5").fetchall()
    if lapsers:
        print("\nTop leeches:")
        for r in lapsers:
            print(f"  - {r['lapses']}x :: {r['front'][:60]}")

def cmd_forecast(args):
    days=int(args[0]) if args else 14
    con=connect()
    start=dt.datetime.now().date()
    print("Due forecast:")
    for i in range(days):
        day=start + dt.timedelta(days=i)
        c=con.execute("SELECT COUNT(*) FROM cards WHERE suspended=0 AND date(due)=date(?)",(day.isoformat(),)).fetchone()[0]
        print(f"  {day.isoformat()}: {c}")

def cmd_ics(args):
    if not args: print("Usage: ics out.ics [days]"); return
    out=args[0]; days=int(args[1]) if len(args)>1 else 14
    con=connect()
    start=dt.datetime.now().date()
    vevents=[]; from datetime import datetime
    for i in range(days):
        day=start + dt.timedelta(days=i)
        c=con.execute("SELECT COUNT(*) FROM cards WHERE suspended=0 AND date(due)=date(?)",(day.isoformat(),)).fetchone()[0]
        if c==0: continue
        dtstamp=datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
        dtstart=day.strftime("%Y%m%d")
        uid=f"study-{dtstart}-{c}@local"
        vevents.append(f"BEGIN:VEVENT\nDTSTAMP:{dtstamp}\nUID:{uid}\nDTSTART;VALUE=DATE:{dtstart}\nSUMMARY:Study - {c} card(s) due\nEND:VEVENT")
    ics="BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//StudySuite//EN\n" + "\n".join(vevents) + "\nEND:VCALENDAR\n"
    with open(out,"w",encoding="utf-8") as f: f.write(ics)
    print(f"Wrote calendar to {out}")

def cmd_staleness(args):
    days=30
    if "--days" in args:
        i=args.index("--days")
        if i+1<len(args): days=int(args[i+1])
    con=connect(); now=dt.datetime.now()
    rows=con.execute("SELECT tags, MAX(last_reviewed) as last FROM cards WHERE tags!='' GROUP BY tags").fetchall()
    print(f"Topic staleness (last reviewed; threshold ~{days} days):")
    for r in rows:
        tags=r["tags"]; last=r["last"]
        if not last: print(f"  - {tags}: never"); continue
        last_dt=dt.datetime.fromisoformat(last); delta=(now-last_dt).days
        alert="⚠️" if delta>=days else ""
        print(f"  - {tags}: {delta} days ago {alert}")

def cmd_suspend(args, value):
    if not args: print("Usage: suspend [card_id] | unsuspend [card_id]"); return
    card_id=int(args[0]); con=connect()
    with con: con.execute("UPDATE cards SET suspended=? WHERE id=?",(1 if value else 0, card_id))
    print(("Suspended" if value else "Unsuspended") + f" card {card_id}")

def cmd_backup(args):
    if not args: print("Usage: backup out.zip | restore in.zip"); return
    out=args[0]
    with zipfile.ZipFile(out,"w",zipfile.ZIP_DEFLATED) as z:
        if os.path.exists(DB_PATH): z.write(DB_PATH, arcname="study.db")
    print(f"Backup written to {out}")

def cmd_restore(args):
    if not args: print("Usage: restore in.zip"); return
    inp=args[0]
    with zipfile.ZipFile(inp,"r") as z: z.extract("study.db",".")
    print("Restored study.db from backup.")

def usage(): print(HELP)

def main():
    if len(sys.argv)<2: usage(); return
    cmd,*args=sys.argv[1:]
    if cmd=="init": init_db()
    elif cmd=="config": cmd_config(args)
    elif cmd=="deck": cmd_deck(args)
    elif cmd=="add": cmd_add(args)
    elif cmd=="import": cmd_import(args)
    elif cmd=="export": cmd_export(args)
    elif cmd=="review": cmd_review(args)
    elif cmd=="quiz": cmd_quiz(args)
    elif cmd=="stats": cmd_stats(args)
    elif cmd=="forecast": cmd_forecast(args)
    elif cmd=="ics": cmd_ics(args)
    elif cmd=="staleness": cmd_staleness(args)
    elif cmd=="suspend": cmd_suspend(args, True)
    elif cmd=="unsuspend": cmd_suspend(args, False)
    elif cmd=="backup": cmd_backup(args)
    elif cmd=="restore": cmd_restore(args)
    else: usage()

if __name__=="__main__":
    main()
