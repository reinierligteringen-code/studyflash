Study Suite — Offline Handwriting to LaTeX (pix2tex)
===========================================================

This update adds:
- Type/Handwrite tabs for Front/Back in /cards/new
- Canvas with grid background (not embedded), Undo/Clear, Convert → LaTeX
- Backend endpoint /ocr/latex that tries pix2tex (module), then pix2tex CLI

Install (Windows, CPU only):
1) Python deps:
   py -m pip install fastapi uvicorn jinja2 python-multipart pillow
2) PyTorch CPU wheels (no GPU):
   py -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
3) pix2tex:
   py -m pip install pix2tex
   (Optional but helpful) py -m pip install opencv-python

Run:
   py -m uvicorn webapp:app --reload

On iPad:
- Open http://<your-laptop-ip>:8000/cards/new
- Select 'Handwrite (beta)' tab, write your formula, click 'Convert to LaTeX → insert'

Notes:
- Handwriting accuracy is limited with free models. Neat, high-contrast writing helps.
- If you see “pix2tex not available”, ensure steps 2–3 succeeded.
