#!/bin/bash

# Start XTTS-v2 server with precomputed speaker embeddings
# This script starts the server and automatically preloads all voice embeddings

echo "🚀 Starting XTTS-v2 server with precomputed embeddings..."
echo "Server will be available at: http://localhost:5006"
echo ""

# Check if voices directory exists
if [ ! -d "voices" ]; then
    echo "❌ Error: voices directory not found!"
    echo "Please make sure you're running this script from the server directory"
    echo "and that the voices directory contains the Korean and English voice files."
    exit 1
fi

# List available voice files
echo "📁 Available voice files:"
ls -la voices/*.wav 2>/dev/null || echo "   No .wav files found in voices directory"
echo ""

# Check if Python dependencies are installed
echo "🔍 Checking Python dependencies..."
python3 -c "import torch, TTS, flask, soundfile, librosa" 2>/dev/null
if [ $? -ne 0 ]; then
    echo "❌ Error: Missing Python dependencies!"
    echo "Please install the required packages:"
    echo "  pip install torch TTS flask soundfile librosa"
    exit 1
fi

echo "✅ Dependencies check passed"
echo ""

# Start the server
echo "🎤 Starting XTTS-v2 server..."
echo "The server will automatically preload speaker embeddings for all voice files."
echo "This may take a few seconds on first startup..."
echo ""
echo "Available endpoints:"
echo "  - POST /tts        - Standard TTS synthesis"
echo "  - POST /tts_fast   - Fast synthesis with precomputed embeddings (recommended)"
echo "  - POST /tts_direct - Direct model synthesis"
echo "  - GET  /health     - Server health and cache status"
echo "  - GET  /cache/stats - Detailed cache statistics"
echo "  - POST /cache/preload - Manual cache preload"
echo ""

# Use uvicorn for production or python for development
if command -v uvicorn &> /dev/null; then
    echo "Using uvicorn for production server..."
    uvicorn xtts_v2_server:asgi_app --host 0.0.0.0 --port 5006 --reload
else
    echo "Using Python development server..."
    echo "For production, install uvicorn: pip install uvicorn"
    python3 xtts_v2_server.py
fi
