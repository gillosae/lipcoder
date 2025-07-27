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
    print(f"[ASR] Received request with content-type: {request.content_type}")
    print(f"[ASR] Request files: {list(request.files.keys())}")
    print(f"[ASR] Request form: {list(request.form.keys())}")
    print(f"[ASR] Request data length: {len(request.data) if request.data else 0}")
    
    temp_path = None
    
    try:
        # Handle form data (original method)
        if 'audio' in request.files:
            print(f"[ASR] Processing form data audio file")
            audio_file = request.files['audio']
            print(f"[ASR] Audio file received: {audio_file.filename}, size: {len(audio_file.read())}")
            audio_file.seek(0)  # Reset file pointer
            
            temp_path = os.path.join('/tmp', f"asr_{uuid.uuid4().hex}.wav")
            audio_file.save(temp_path)
            print(f"[ASR] Saved form audio to: {temp_path}")
            
        # Handle raw WAV data (new method)
        elif request.content_type == 'audio/wav':
            print(f"[ASR] Processing raw WAV data")
            audio_data = request.data
            print(f"[ASR] Raw audio data received: {len(audio_data)} bytes")
            
            temp_path = os.path.join('/tmp', f"asr_{uuid.uuid4().hex}.wav")
            with open(temp_path, 'wb') as f:
                f.write(audio_data)
            print(f"[ASR] Saved raw audio to: {temp_path}")
            
        else:
            print(f"[ASR] Error: No audio file provided. Content-Type: {request.content_type}")
            return jsonify({'error': 'No audio file provided.'}), 400

        # Process the audio file
        batches = split_into_batches([temp_path], batch_size=1)
        input_data = prepare_model_input(read_batch(batches[0]), device=device)

        # Run inference and decode
        output = model(input_data)
        result = decoder(output[0].cpu())
        
        print(f"[ASR] Transcription result: {result}")
        return jsonify({'text': result})
        
    except Exception as e:
        print(f"[ASR] Error during processing: {e}")
        return jsonify({'error': str(e)}), 500
    finally:
        # Clean up the temporary file
        if temp_path and os.path.exists(temp_path):
            os.remove(temp_path)
            print(f"[ASR] Cleaned up: {temp_path}")

if __name__ == '__main__':
    # Run a WSGI server on port 5003
    app.run(port=5003)