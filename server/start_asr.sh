#!/bin/bash

# ASR Server Startup Script with Dynamic Python Detection
# This script finds Python and starts the ASR server

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}🎤 Starting ASR Server...${NC}"

# Get the directory of this script
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
cd "$SCRIPT_DIR"

# Source common Python utilities
source "$SCRIPT_DIR/python_utils.sh"

# Setup Python environment
PYTHON_CMD=$(setup_python_environment "ASR Server")
if [ $? -ne 0 ]; then
    exit 1
fi

# Check if gunicorn is available
if ! $PYTHON_CMD -c "import gunicorn" &> /dev/null; then
    echo -e "${YELLOW}⚠️  Warning: gunicorn not found, installing...${NC}"
    if ! install_package "$PYTHON_CMD" "gunicorn" "gunicorn"; then
        echo -e "${RED}❌ Error: Failed to install gunicorn${NC}"
        echo -e "${YELLOW}💡 Try: $PYTHON_CMD -m pip install gunicorn${NC}"
        exit 1
    fi
fi

# Check and install required packages using common function
if ! check_and_install_packages "$PYTHON_CMD" \
    "torch" "torch" \
    "flask" "flask" \
    "flask_cors" "flask-cors" \
    "numpy" "numpy" \
    "asgiref" "asgiref"; then
    exit 1
fi

# Set default port
PORT=${1:-5004}
echo -e "${BLUE}📡 Starting ASR server on port $PORT...${NC}"

# Check if port is already in use
if lsof -Pi :$PORT -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo -e "${YELLOW}⚠️  Warning: Port $PORT is already in use${NC}"
    echo -e "${YELLOW}   Attempting to kill existing process...${NC}"
    
    # Kill existing process on the port
    PID=$(lsof -ti:$PORT 2>/dev/null)
    if [ ! -z "$PID" ]; then
        kill -9 $PID 2>/dev/null
        sleep 2
        echo -e "${GREEN}✅ Killed existing process on port $PORT${NC}"
    fi
fi

# Start the server
echo -e "${GREEN}🚀 ASR Server starting on http://localhost:$PORT${NC}"
echo -e "${BLUE}📝 Logs will appear below...${NC}"
echo -e "${YELLOW}   Press Ctrl+C to stop the server${NC}"
echo ""

# Execute with error handling
exec $PYTHON_CMD -m gunicorn --workers 2 --bind 0.0.0.0:$PORT silero_asr_server:app 