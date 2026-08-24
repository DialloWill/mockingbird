import os
from dotenv import load_dotenv

load_dotenv()

GROQ_API_KEY = os.getenv('GROQ_API_KEY')
MODEL_NAME = "openai/gpt-oss-120b"
BOT_NAME = "Mockingbird"

ELEVENLABS_API_KEY = os.getenv('ELEVENLABS_API_KEY')
print(f"[DEBUG] ElevenLabs key loaded: {'YES, length=' + str(len(ELEVENLABS_API_KEY)) if ELEVENLABS_API_KEY else 'NO — key is None/empty'}")
# "Rachel" — a stock premade ElevenLabs voice available on every account,
# used as a sensible default; override via env if you prefer another voice.
ELEVENLABS_VOICE_ID = os.getenv('ELEVENLABS_VOICE_ID', '21m00Tcm4TlvDq8ikWAM')