# Card UI for Study Suite (web)
This is a **drop-in replacement** for the web front-end with a real flashcard look, flip animation, and keyboard shortcuts.

## What changed
- **Single-card stage:** one big card centered on screen.
- **Flip interaction:** Space / F (or the “Flip” button).
- **Ratings:** 1=Again, 2=Hard, 3=Good, 4=Easy (buttons + keyboard).
- **Confidence:** press **C** then type 1–5 (optional).
- **Filters:** deck + tag filter remain at the top.
- **MathJax:** LaTeX renders correctly.

## How to install
1. Copy these files into your existing project folder (same folder as `study.py`), **overwriting the old `/templates` and `/static` and `webapp.py`**.
2. In that folder, run:
   ```bash
   python -m pip install fastapi uvicorn jinja2
   python webapp.py
   ```
3. Open **http://127.0.0.1:8000**

## Notes
- The server still uses your existing SQLite `study.db` created by `python study.py init`.
- “Due” count at the top reflects current filter (deck/tag).
