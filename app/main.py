from fastapi import FastAPI
from app.api.bookings import router as bookings_router

app = FastAPI()

@app.get("/api/health")
def health():
    return {"status": "ok"}

app.include_router(bookings_router, prefix="/api")
