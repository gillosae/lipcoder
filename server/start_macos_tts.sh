#!/bin/bash

# macOS Native TTS Server Startup Script
# This script starts the macOS native TTS server using the 'say' command

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}🍎 Starting macOS Native TTS Server...${NC}"

# Check if we're on macOS
if [[ "$OSTYPE" != "darwin"* ]]; then
    echo -e "${RED}❌ Error: macOS TTS server can only run on macOS${NC}"
    exit 1
fi

# Check if 'say' command is available
if ! command -v say &> /dev/null; then
    echo -e "${RED}❌ Error: macOS 'say' command not found${NC}"
    exit 1
fi

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
PYTHON_CMD=$(setup_python_environment "macOS TTS Server")
if [ $? -ne 0 ]; then
    exit 1
fi

# Check and install required packages using common function
if ! check_and_install_packages "$PYTHON_CMD" \
    "flask" "flask" \
    "flask_cors" "flask-cors"; then
    exit 1
fi

# Set default port
PORT=${PORT:-5008}

# Get the directory of this script
SERVER_SCRIPT="$SCRIPT_DIR/macos_tts_server.py"

# Check if server script exists
if [ ! -f "$SERVER_SCRIPT" ]; then
    echo -e "${RED}❌ Error: Server script not found at $SERVER_SCRIPT${NC}"
    exit 1
fi

# Test 'say' command (silent test)
echo -e "${BLUE}🔍 Testing macOS 'say' command...${NC}"
if echo "" | say >/dev/null 2>&1; then
    echo -e "${GREEN}✅ macOS 'say' command is working${NC}"
else
    echo -e "${RED}❌ Error: macOS 'say' command test failed${NC}"
    exit 1
fi

# Show available voices (first 10)
echo -e "${BLUE}🎤 Available macOS voices (showing first 10):${NC}"
say -v '?' | head -10 | while read line; do
    voice_name=$(echo "$line" | awk '{print $1}')
    echo -e "${GREEN}  • $voice_name${NC}"
done

echo -e "${BLUE}📡 Starting server on port $PORT...${NC}"

# Kill any existing processes on the target port using common function
if ! kill_port_processes $PORT; then
    exit 1
fi

# Export port for the Python script
export PORT=$PORT

# Start the server
echo -e "${GREEN}🚀 macOS Native TTS Server starting on http://localhost:$PORT${NC}"
echo -e "${BLUE}📝 Logs will appear below...${NC}"
echo -e "${YELLOW}   Press Ctrl+C to stop the server${NC}"
echo ""

# Run the server with error handling
$PYTHON_CMD "$SERVER_SCRIPT"

# Check exit code
EXIT_CODE=$?
if [ $EXIT_CODE -ne 0 ]; then
    echo -e "${RED}❌ Server exited with error code $EXIT_CODE${NC}"
    exit $EXIT_CODE
else
    echo -e "${GREEN}✅ Server stopped gracefully${NC}"
fi
