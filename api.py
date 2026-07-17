# api.py
from flask import Flask, request, jsonify
from flask_cors import CORS

from modules.brain import JarvisBrain

app = Flask(__name__)
CORS(app)

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


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
