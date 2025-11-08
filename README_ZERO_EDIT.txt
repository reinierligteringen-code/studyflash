ZERO-EDIT MIXED OCR PACKAGE
=============================

This package mounts a new endpoint `/ocr/mixed` **without editing `webapp.py`** by using Python's
auto-import of `sitecustomize`.

What you do
-----------
1) Unzip into your project root (same folder as `webapp.py`), overwrite when asked:
   - `ocr_mixed_router.py`
   - `sitecustomize.py`
   - `static/handwrite.js`
   - `static/ocr_insert.js`

2) Make sure you've installed dependencies (one-time):
   pip install pytesseract opencv-python pillow numpy
   pip install pix2tex torch torchvision --index-url https://download.pytorch.org/whl/cpu
   And install Tesseract system engine (Windows):
   choco install tesseract -y

3) Restart your server as usual:
   python -m uvicorn webapp:app --host 0.0.0.0 --port 8000 --reload

Why this works
--------------
- Python automatically imports `sitecustomize` if it exists on sys.path.
- Our `sitecustomize.py` imports your FastAPI `app` from `webapp` and mounts the router.

Troubleshooting
---------------
- If you don't see `/ocr/mixed` in http://localhost:8000/docs, ensure `sitecustomize.py`
  is in the same folder that Python adds to sys.path when launching uvicorn.
- If your app file isn't named `webapp.py` or your app object isn't named `app`,
  edit `sitecustomize.py` accordingly.
