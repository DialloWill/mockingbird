# api.py
import requests
from flask import Flask, request, jsonify, Response
from flask_cors import CORS

from modules.brain import JarvisBrain
from config.settings import ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID

app = Flask(__name__)
CORS(app)

ELEVENLABS_TTS_URL = f"https://api.elevenlabs.io/v1/text-to-speech/{ELEVENLABS_VOICE_ID}"

# Single JarvisBrain instance shared across requests so conversation_history
# persists for the life of the server process.
brain = JarvisBrain()


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})


@app.route("/chat", methods=["POST"])
def chat():
    data = request.get_json(silent=True)

    if not data or "message" not in data:
        return jsonify({"error": "Request body must be JSON with a 'message' field."}), 400

    message = data["message"]
    if not isinstance(message, str) or not message.strip():
        return jsonify({"error": "'message' must be a non-empty string."}), 400

    try:
        response = brain.think(message)
    except Exception as e:
        return jsonify({"error": f"Jarvis failed to process the message: {str(e)}"}), 500

    return jsonify({"response": response})


@app.route("/speak", methods=["POST"])
def speak():
    data = request.get_json(silent=True)

    if not data or "text" not in data:
        return jsonify({"error": "Request body must be JSON with a 'text' field."}), 400

    text = data["text"]
    if not isinstance(text, str) or not text.strip():
        return jsonify({"error": "'text' must be a non-empty string."}), 400

    # This endpoint only exists to keep the ElevenLabs key server-side; the
    # free engine runs entirely client-side via the browser's Web Speech API
    # and never calls this route.
    engine = data.get("engine", "premium")
    if engine != "premium":
        return jsonify({
            "error": "The /speak endpoint only serves the 'premium' engine. "
                     "Use the browser's built-in speechSynthesis for 'free'."
        }), 400

    if not ELEVENLABS_API_KEY:
        return jsonify({"error": "ELEVENLABS_API_KEY is not configured on the server."}), 503

    try:
        upstream = requests.post(
            ELEVENLABS_TTS_URL,
            headers={
                "xi-api-key": ELEVENLABS_API_KEY,
                "Content-Type": "application/json",
                "Accept": "audio/mpeg",
            },
            json={
                "text": text,
                "model_id": "eleven_monolingual_v1",
                "voice_settings": {"stability": 0.5, "similarity_boost": 0.75},
            },
            timeout=20,
        )
    except requests.RequestException as e:
        return jsonify({"error": f"Couldn't reach ElevenLabs: {str(e)}"}), 502

    if upstream.status_code != 200:
        try:
            detail = upstream.json()
        except ValueError:
            detail = upstream.text
        return jsonify({
            "error": f"ElevenLabs request failed ({upstream.status_code})",
            "detail": detail,
        }), 502

    return Response(upstream.content, mimetype="audio/mpeg")


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
