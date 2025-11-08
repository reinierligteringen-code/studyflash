
# ocr_mixed_router.py
from fastapi import APIRouter, UploadFile, File
from fastapi.responses import JSONResponse
from typing import List, Tuple
import numpy as np
import cv2
from PIL import Image
import io, tempfile, subprocess, os

import pytesseract

_pix = None
try:
    from pix2tex.cli import LatexOCR  # type: ignore
    _pix = LatexOCR()
except Exception:
    _pix = None

router = APIRouter()

def pil_from_bytes(b: bytes) -> Image.Image:
    im = Image.open(io.BytesIO(b)).convert("RGB")
    return im

def to_gray(np_rgb: np.ndarray) -> np.ndarray:
    if len(np_rgb.shape) == 2:
        return np_rgb
    return cv2.cvtColor(np_rgb, cv2.COLOR_RGB2GRAY)

def preprocess(gray: np.ndarray) -> np.ndarray:
    g = cv2.GaussianBlur(gray, (3, 3), 0)
    th = cv2.adaptiveThreshold(g, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                               cv2.THRESH_BINARY_INV, 21, 10)
    return th

def find_boxes(gray: np.ndarray) -> List[Tuple[int, int, int, int]]:
    th = preprocess(gray)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (15, 3))
    dil = cv2.dilate(th, kernel, iterations=1)
    contours, _ = cv2.findContours(dil, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    boxes = []
    for c in contours:
        x, y, w, h = cv2.boundingRect(c)
        if w * h < 300:
            continue
        if h < 8 or w < 8:
            continue
        boxes.append((x, y, w, h))
    boxes.sort(key=lambda b: (b[1], b[0]))
    merged = []
    for b in boxes:
        if not merged:
            merged.append(b)
            continue
        x, y, w, h = b
        px, py, pw, ph = merged[-1]
        same_line = abs((y + h/2) - (py + ph/2)) < max(h, ph) * 0.6
        overlap_x = not (x > px + pw + 6 or px > x + w + 6)
        if same_line and overlap_x:
            nx = min(x, px); ny = min(y, py)
            nx2 = max(x+w, px+pw); ny2 = max(y+h, py+ph)
            merged[-1] = (nx, ny, nx2 - nx, ny2 - ny)
        else:
            merged.append(b)
    return merged

def pix2tex_infer(roi_rgb: np.ndarray) -> str:
    try:
        if _pix is not None:
            im = Image.fromarray(roi_rgb)
            latex = _pix(im)  # type: ignore
            return (latex or "").strip()
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
            cv2.imwrite(tmp.name, cv2.cvtColor(roi_rgb, cv2.COLOR_RGB2BGR))
            tmp_path = tmp.name
        try:
            proc = subprocess.run(["pix2tex", tmp_path], capture_output=True, text=True, timeout=30)
            out = (proc.stdout or "").strip()
            return out
        finally:
            try: os.remove(tmp_path)
            except: pass
    except Exception:
        return ""

def tesseract_text(roi_gray: np.ndarray) -> str:
    cfg = "--oem 1 --psm 6"
    txt = pytesseract.image_to_string(roi_gray, lang="eng", config=cfg)
    return (txt or "").strip()

def is_mathish(latex: str) -> bool:
    s = latex.strip()
    if not s: return False
    hit = any(tok in s for tok in ["\\frac", "\\sqrt", "\\sum", "\\int", "\\cdot", "\\times", "\\leq", "\\geq", "\\begin", "^", "_", "="])
    if len(s) <= 2 and not hit:
        return False
    return hit or s.startswith("\\")

def merge_lines(chunks: List[Tuple[int,int,int,int,str,bool]]) -> str:
    if not chunks: return ""
    chunks.sort(key=lambda c: (c[1], c[0]))
    lines = []
    current_y = None
    current_line = []
    for x,y,w,h,txt,is_m in chunks:
        yc = y + h/2
        if current_y is None or abs(yc - current_y) > max(h, 18):
            if current_line:
                lines.append(current_line)
            current_line = []
            current_y = yc
        current_line.append((x, txt, is_m))
    if current_line:
        lines.append(current_line)
    parts = []
    for line in lines:
        line.sort(key=lambda t: t[0])
        segs = []
        for _,txt,is_m in line:
            if not txt: continue
            segs.append(f"\\({txt}\\)" if is_m else txt)
        parts.append(" ".join(segs).strip())
    return "\\n".join(parts).strip()

from fastapi import APIRouter
@router.post("/ocr/mixed")
async def ocr_mixed(image: UploadFile = File(...)):
    try:
        content = await image.read()
        pil = pil_from_bytes(content)
        rgb = np.array(pil)
        gray = to_gray(rgb)
        boxes = find_boxes(gray)
        if not boxes:
            boxes = [(0,0,gray.shape[1], gray.shape[0])]
        chunks = []
        for (x,y,w,h) in boxes:
            roi_rgb = rgb[y:y+h, x:x+w]
            roi_gray = gray[y:y+h, x:x+w]
            latex = pix2tex_infer(roi_rgb)
            text  = tesseract_text(roi_gray)
            use_math = False
            if is_mathish(latex):
                if (len(text) <= 2) or (len(latex) >= max(4, len(text))):
                    use_math = True
            chosen = latex if use_math else text
            chunks.append((x,y,w,h, chosen, use_math))
        merged = merge_lines(chunks)
        return JSONResponse({"ok": True, "merged": merged})
    except Exception as e:
        return JSONResponse({"ok": False, "error": f"{type(e).__name__}: {e}"})
