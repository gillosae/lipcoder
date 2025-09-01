#!/bin/bash

# XTTS-v2 TTS Server Startup Script - DISABLED DUE TO STABILITY ISSUES
# This script is disabled to prevent crashes. Use MacOS TTS instead.
echo "⚠️  XTTS-v2 server is disabled due to stability issues."
echo "💡 Using MacOS TTS server on port 5008 instead."
exit 0

# XTTS-v2 TTS Server Startup Script with Dynamic Python Detection
# This script finds Python and starts the XTTS-v2 TTS server

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}🎙️ Starting XTTS-v2 TTS Server...${NC}"

# Get the directory of this script
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
cd "$SCRIPT_DIR"

# Source common Python utilities (ensure bash compatibility)
if [ -n "$BASH_VERSION" ]; then
    source "$SCRIPT_DIR/python_utils.sh"
else
    # If not bash, try to run with bash
    exec bash "$0" "$@"
fi

# Setup Python environment
PYTHON_CMD=$(setup_python_environment "XTTS-v2 Server")
if [ $? -ne 0 ]; then
    exit 1
fi

# Check and install required packages using common function
if ! check_and_install_packages "$PYTHON_CMD" \
    "torch" "torch" \
    "TTS" "TTS" \
    "flask" "flask" \
    "soundfile" "soundfile" \
    "librosa" "librosa" \
    "omegaconf" "omegaconf" \
    "numpy" "numpy"; then
    exit 1
fi

# Set the port from command line argument
PORT=${1:-5006}

# Set environment variable for the port
export XTTS_V2_PORT=$PORT

echo -e "${BLUE}📡 Starting XTTS-v2 server on port $PORT...${NC}"
echo -e "${GREEN}🚀 XTTS-v2 TTS Server starting with precomputed embeddings${NC}"

# Run the server directly with the specified port
$PYTHON_CMD -c "
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
