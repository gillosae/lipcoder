from asgiref.wsgi import WsgiToAsgi
from flask import Flask, request, send_file
import torch
import uuid
import os
from silero_tts.silero_tts import SileroTTS

app = Flask(__name__)

# Initialize persistent SileroTTS model
device = 'cuda' if torch.cuda.is_available() else 'cpu'
tts_model = SileroTTS(
    model_id='v3_en',
    language='en',
    speaker='en_3',
    sample_rate=24000,
    device=device
)

# Expose ASGI application for Uvicorn
asgi_app = WsgiToAsgi(app)

@app.route('/tts', methods=['POST'])
def tts():
    data = request.json
    text = data['text']
    speaker = data.get('speaker', 'en_3')
    sample_rate = data.get('sample_rate', 24000)

    # Update model parameters
    tts_model.speaker = speaker
    tts_model.sample_rate = sample_rate

    # Generate to a temporary file
    temp_path = os.path.join('/tmp', f"tts_{uuid.uuid4().hex}.wav")
    tts_model.tts(text, temp_path)

    return send_file(temp_path, mimetype='audio/wav')

if __name__ == '__main__':
    app.run(port=5002)