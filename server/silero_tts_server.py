from asgiref.wsgi import WsgiToAsgi
from flask import Flask, request, send_file
import torch
import uuid
import os
import numpy as np
import soundfile as sf
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

    # Generate to a temporary mono file
    mono_temp_path = os.path.join('/tmp', f"tts_mono_{uuid.uuid4().hex}.wav")
    tts_model.tts(text, mono_temp_path)
    
    # Convert mono to stereo
    stereo_temp_path = os.path.join('/tmp', f"tts_stereo_{uuid.uuid4().hex}.wav")
    
    # Read the mono audio
    mono_audio, sr = sf.read(mono_temp_path)
    
    # Convert mono to stereo by duplicating the channel
    if len(mono_audio.shape) == 1:  # Ensure it's mono
        stereo_audio = np.column_stack((mono_audio, mono_audio))
    else:
        stereo_audio = mono_audio  # Already stereo or multi-channel
    
    # Write as stereo
    sf.write(stereo_temp_path, stereo_audio, sr)
    
    # Clean up mono file
    if os.path.exists(mono_temp_path):
        os.remove(mono_temp_path)

    return send_file(stereo_temp_path, mimetype='audio/wav')

if __name__ == '__main__':
    app.run(port=5002)