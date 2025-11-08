# Study Cards — Draw & Images (No OCR)

A lightweight, offline web app to handwrite flashcards on a grid canvas and place images (e.g., graphs) onto the card. No handwriting recognition. Your strokes and images are saved locally in the browser (and you can export/import the deck as JSON).

## Features
- Pen with thin default lines (adjustable)
- Eraser (real erasing of strokes; images are moved/resized)
- Add images (via file picker). Drag to move. Resize with the "Img scale" slider, and rotate with the **Rotate** slider or ⟲/⟳ buttons
- Front/Back sides for each flashcard
- New / Duplicate / Delete cards, Next/Prev navigation
- Undo/Redo
- Export current side as PNG (includes grid and your content)
- Export/Import entire deck as JSON (images embedded as data URLs)

## How to use
1. Unzip the archive.
2. Open `index.html` in your browser (Chrome/Edge/Firefox). No install needed.
3. Draw with **Pen**. Use **Eraser** to erase strokes. Use **Select** to move images.
4. Click **🖼 Add image** and choose a file from your computer.
5. Use **⬇️ PNG** to export the visible side as an image.
6. Use **⬇️ Deck** to export a JSON backup (you can re-import with **⬆️ Deck**).

## Notes
- Everything is local. If you clear browser storage, your deck will be removed unless you exported it.
- Exported deck JSON contains embedded images as data URLs, so a single file is enough for backup.
- Canvas size defaults to 1200×800. You can change that in `index.html` if you prefer.

## Keyboard shortcuts
- **P** — Pen
- **E** — Eraser
- **V** — Select/Move images
- **Ctrl+Z** — Undo
- **Ctrl+Y** — Redo


## New Navigation
- `index.html` — Home page with links to Rehearse, Manage Sets, and Editor.
- `manage.html` — Create/rename/delete/import/export sets; open Editor or Rehearse for a set.
- `editor.html?set=<id>` — Drawing editor tied to a specific set.
- `rehearse.html?set=<id>` — Rehearsal player; pick a set if `set` is omitted.
