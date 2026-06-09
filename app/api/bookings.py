from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter()

class Booking(BaseModel):
    name: str
    email: str
    phone: str
    date: str
    service: str

@router.post("/bookings")
async def create_booking(booking: Booking):
    return {"message": "Booking received", "data": booking}
