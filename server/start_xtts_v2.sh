#!/bin/bash

# Start XTTS-v2 TTS Server with precomputed embeddings
cd "$(dirname "$0")"

# Check and install dependencies
echo "Checking XTTS-v2 dependencies..."

# Check each dependency individually and install if missing
missing_deps=()

if ! /opt/homebrew/bin/python3.10 -c "import torch" 2>/dev/null; then
    missing_deps+=("torch")
fi

if ! /opt/homebrew/bin/python3.10 -c "import TTS" 2>/dev/null; then
    missing_deps+=("TTS")
fi

if ! /opt/homebrew/bin/python3.10 -c "import flask" 2>/dev/null; then
    missing_deps+=("flask")
fi

if ! /opt/homebrew/bin/python3.10 -c "import soundfile" 2>/dev/null; then
    missing_deps+=("soundfile")
fi

if ! /opt/homebrew/bin/python3.10 -c "import librosa" 2>/dev/null; then
    missing_deps+=("librosa")
fi

if [ ${#missing_deps[@]} -gt 0 ]; then
    echo "Installing missing dependencies: ${missing_deps[*]}"
    pip3 install "${missing_deps[@]}"
else
    echo "XTTS-v2 dependencies already installed, skipping..."
fi

echo "Starting XTTS-v2 server on port $1 with Flask (precomputed embeddings)..."

# Set the port from command line argument
PORT=${1:-5006}

# Set environment variable for the port
export XTTS_V2_PORT=$PORT

# Run the server directly with the specified port
/opt/homebrew/bin/python3.10 -c "
import os
import sys

# Get port from environment variable
port = int(os.environ.get('XTTS_V2_PORT', 5006))

# Import and run the server
sys.path.append('.')
from xtts_v2_server import app

if __name__ == '__main__':
    print(f'Starting XTTS-v2 server on port {port}')
    app.run(port=port, host='0.0.0.0', debug=False)
"
