# api.py
import os
import requests
from flask import Flask, request, jsonify, Response
from flask_cors import CORS

from modules.brain import MockingbirdBrain
from config.settings import ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID  # kept for reference/fallback if needed

app = Flask(__name__)
CORS(app)

# --- Voicebox (local, free TTS) replaces ElevenLabs as the premium voice engine ---
VOICEBOX_URL = "http://127.0.0.1:17493/generate/stream"
VOICEBOX_PROFILE_ID = "f15bdd00-98ca-4f55-9bd2-501ac465ac48"  # "Mockingbird" profile (Kokoro / Onyx)

# Single MockingbirdBrain instance shared across requests so conversation_history
# persists for the life of the server process.
brain = MockingbirdBrain()


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
        return jsonify({"error": f"Mockingbird failed to process the message: {str(e)}"}), 500

    return jsonify({"response": response})


@app.route("/speak", methods=["POST"])
def speak():
    data = request.get_json(silent=True)

    if not data or "text" not in data:
        return jsonify({"error": "Request body must be JSON with a 'text' field."}), 400

    text = data["text"]
    if not isinstance(text, str) or not text.strip():
        return jsonify({"error": "'text' must be a non-empty string."}), 400

    # This endpoint only exists to keep the TTS call server-side; the free
    # engine runs entirely client-side via the browser's Web Speech API and
    # never calls this route.
    engine = data.get("engine", "premium")
    if engine != "premium":
        return jsonify({
            "error": "The /speak endpoint only serves the 'premium' engine. "
                     "Use the browser's built-in speechSynthesis for 'free'."
        }), 400

    try:
        upstream = requests.post(
            VOICEBOX_URL,
            headers={"Content-Type": "application/json"},
            json={
                "profile_id": VOICEBOX_PROFILE_ID,
                "text": text,
                "language": "en",
                "engine": "kokoro",
            },
            timeout=60,
        )
    except requests.RequestException as e:
        return jsonify({
            "error": f"Couldn't reach Voicebox — is the Voicebox app running? ({str(e)})"
        }), 502

    if upstream.status_code != 200:
        try:
            detail = upstream.json()
        except ValueError:
            detail = upstream.text
        return jsonify({
            "error": f"Voicebox generation failed ({upstream.status_code})",
            "detail": detail,
        }), 502

    return Response(upstream.content, mimetype="audio/wav")


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)