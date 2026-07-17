import os
from dotenv import load_dotenv

load_dotenv()

GROQ_API_KEY = os.getenv('GROQ_API_KEY')
MODEL_NAME = "llama-3.3-70b-versatile"
BOT_NAME = "Jarvis"

ELEVENLABS_API_KEY = os.getenv('ELEVENLABS_API_KEY')
# "Rachel" — a stock premade ElevenLabs voice available on every account,
# used as a sensible default; override via env if you prefer another voice.
ELEVENLABS_VOICE_ID = os.getenv('ELEVENLABS_VOICE_ID', '21m00Tcm4TlvDq8ikWAM')