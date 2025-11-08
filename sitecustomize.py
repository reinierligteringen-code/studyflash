
# sitecustomize.py
# Auto-imported by Python if present on sys.path.
# It injects the OCR router into your FastAPI app WITHOUT editing webapp.py.
try:
    from webapp import app  # your FastAPI app object
    from ocr_mixed_router import router as ocr_mixed_router
    app.include_router(ocr_mixed_router)
    # Optional: print to server log
    print("[sitecustomize] Mixed OCR router mounted at /ocr/mixed")
except Exception as e:
    print("[sitecustomize] Skipped mounting OCR router:", e)
