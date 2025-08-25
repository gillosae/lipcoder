#!/bin/bash
cd "$(dirname "$0")"

# Install required Python packages if not already installed
echo "Installing MMS-TTS dependencies..."
/opt/homebrew/opt/python@3.10/Frameworks/Python.framework/Versions/3.10/bin/python3.10 -m pip install --upgrade transformers torch torchaudio soundfile scipy librosa flask asgiref gunicorn

# Start the MMS-TTS server
echo "Starting MMS-TTS server on port $1..."
exec /opt/homebrew/opt/python@3.10/Frameworks/Python.framework/Versions/3.10/bin/python3.10 -m gunicorn --workers 1 --bind 0.0.0.0:$1 --timeout 120 mms_tts_server:app
