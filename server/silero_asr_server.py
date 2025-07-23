from asgiref.wsgi import WsgiToAsgi
from flask import Flask, request, jsonify
import torch
import os
import uuid

app = Flask(__name__)

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

    # Read and preprocess (resample to 16 kHz)
    wav = read_audio(temp_path, sampling_rate=16000)
    batches = split_into_batches([wav], batch_size=1)
    input_data = prepare_model_input(batches, device=device)

    # Run inference and decode
    output = model(input_data)
    result = decoder(output[0].cpu())
    os.remove(temp_path)

    return jsonify({'text': result})

if __name__ == '__main__':
    # Run a WSGI server on port 5003
    app.run(port=5003)