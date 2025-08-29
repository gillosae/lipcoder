#!/bin/bash

# eSpeak TTS Server Startup Script with Dynamic Python Detection
# This script finds Python and starts the eSpeak TTS server

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}🔊 Starting eSpeak TTS Server...${NC}"

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
PYTHON_CMD=$(setup_python_environment "eSpeak TTS Server")
if [ $? -ne 0 ]; then
    exit 1
fi

# Check and install required packages using common function
if ! check_and_install_packages "$PYTHON_CMD" \
    "flask" "flask"; then
    exit 1
fi

# Set default port
export PORT=${1:-5005}
echo -e "${BLUE}📡 Starting eSpeak TTS server on port $PORT...${NC}"

# Start the server
echo -e "${GREEN}🚀 eSpeak TTS Server starting on http://localhost:$PORT${NC}"
exec $PYTHON_CMD espeak_tts_server.py
