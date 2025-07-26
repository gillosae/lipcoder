from asgiref.wsgi import WsgiToAsgi
from flask import Flask, request, jsonify
from flask_cors import CORS
import torch
import os
import uuid
import numpy as np

app = Flask(__name__)
CORS(app)  # Enable CORS for all routes

# Initialize device and load the Silero STT model
device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
model, decoder, utils = torch.hub.load(
    repo_or_dir='snakers4/silero-models',
    model='silero_stt',
    language='en',  # also supports 'de', 'es'
    device=device
)  #  [oai_citation:0‡PyTorch](https://pytorch.org/hub/snakers4_silero-models_stt/)
read_batch, split_into_batches, read_audio, prepare_model_input = utils

# Wrap the Flask app for ASGI servers if you want to run with Uvicorn/Hypercorn
asgi_app = WsgiToAsgi(app)

@app.route('/asr', methods=['POST'])
def asr():
    # Expecting a form-data file field named 'audio'
    if 'audio' not in request.files:
        return jsonify({'error': 'No audio file provided.'}), 400
    audio_file = request.files['audio']
    temp_path = os.path.join('/tmp', f"asr_{uuid.uuid4().hex}.wav")
    audio_file.save(temp_path)

    try:
        # Use the Silero workflow: split_into_batches expects file paths
        batches = split_into_batches([temp_path], batch_size=1)
        input_data = prepare_model_input(read_batch(batches[0]), device=device)

        # Run inference and decode
        output = model(input_data)
        result = decoder(output[0].cpu())
        
        return jsonify({'text': result})
    finally:
        # Clean up the temporary file
        if os.path.exists(temp_path):
            os.remove(temp_path)

if __name__ == '__main__':
    # Run a WSGI server on port 5003
    app.run(port=5003)