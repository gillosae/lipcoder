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

# Function to find Python
find_python() {
    # Try different Python executables in order of preference
    local python_candidates=(
        "python3.10"
        "python3.11" 
        "python3.12"
        "python3.9"
        "python3"
        "python"
    )
    
    # Also try common installation paths
    local python_paths=(
        "/opt/homebrew/bin/python3"
        "/opt/homebrew/bin/python3.10"
        "/opt/homebrew/bin/python3.11"
        "/opt/homebrew/opt/python@3.10/bin/python3"
        "/opt/homebrew/opt/python@3.11/bin/python3"
        "/usr/local/bin/python3"
        "/usr/bin/python3"
        "/bin/python3"
    )
    
    # First try candidates in PATH
    for python_cmd in "${python_candidates[@]}"; do
        if command -v "$python_cmd" &> /dev/null; then
            # Check if it's Python 3.8+
            local version=$($python_cmd --version 2>&1 | grep -oE '[0-9]+\.[0-9]+' | head -1)
            local major=$(echo $version | cut -d. -f1)
            local minor=$(echo $version | cut -d. -f2)
            
            if [ "$major" -ge 3 ] && [ "$minor" -ge 8 ]; then
                echo "$python_cmd"
                return 0
            fi
        fi
    done
    
    # Then try specific paths
    for python_path in "${python_paths[@]}"; do
        if [ -x "$python_path" ]; then
            local version=$($python_path --version 2>&1 | grep -oE '[0-9]+\.[0-9]+' | head -1)
            local major=$(echo $version | cut -d. -f1)
            local minor=$(echo $version | cut -d. -f2)
            
            if [ "$major" -ge 3 ] && [ "$minor" -ge 8 ]; then
                echo "$python_path"
                return 0
            fi
        fi
    done
    
    return 1
}

# Find Python executable
PYTHON_CMD=$(find_python)

if [ $? -ne 0 ] || [ -z "$PYTHON_CMD" ]; then
    echo -e "${RED}❌ Error: Could not find Python 3.8+ installation${NC}"
    echo -e "${YELLOW}💡 Please install Python 3.8 or higher:${NC}"
    echo -e "${YELLOW}   • macOS: brew install python${NC}"
    echo -e "${YELLOW}   • Or download from: https://python.org${NC}"
    exit 1
fi

echo -e "${GREEN}✅ Found Python: $PYTHON_CMD${NC}"

# Check Python version
PYTHON_VERSION=$($PYTHON_CMD --version 2>&1)
echo -e "${BLUE}🐍 Python version: $PYTHON_VERSION${NC}"

# Check if gunicorn is available
if ! $PYTHON_CMD -c "import gunicorn" &> /dev/null; then
    echo -e "${YELLOW}⚠️  Warning: gunicorn not found, installing...${NC}"
    $PYTHON_CMD -m pip install gunicorn --break-system-packages
    if [ $? -ne 0 ]; then
        echo -e "${RED}❌ Error: Failed to install gunicorn${NC}"
        echo -e "${YELLOW}💡 Try: pip install gunicorn${NC}"
        exit 1
    fi
    echo -e "${GREEN}✅ gunicorn installed successfully${NC}"
fi

# Check if required packages are available
echo -e "${BLUE}🔍 Checking required packages...${NC}"
required_packages=("torch" "flask" "flask_cors")
for package in "${required_packages[@]}"; do
    if ! $PYTHON_CMD -c "import $package" &> /dev/null; then
        echo -e "${RED}❌ Error: Required package '$package' not found${NC}"
        echo -e "${YELLOW}💡 Install with: pip install $package${NC}"
        exit 1
    fi
done
echo -e "${GREEN}✅ All required packages found${NC}"

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