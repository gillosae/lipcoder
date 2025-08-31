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

# Function to install package with proper error handling
install_package() {
    local package=$1
    local pip_name=${2:-$package}
    
    echo -e "${YELLOW}📦 Installing $package...${NC}"
    
    # Try different installation methods
    if $PYTHON_CMD -m pip install "$pip_name" --break-system-packages &> /dev/null; then
        echo -e "${GREEN}✅ $package installed successfully${NC}"
        return 0
    elif $PYTHON_CMD -m pip install "$pip_name" --user &> /dev/null; then
        echo -e "${GREEN}✅ $package installed successfully (user mode)${NC}"
        return 0
    elif $PYTHON_CMD -m pip install "$pip_name" &> /dev/null; then
        echo -e "${GREEN}✅ $package installed successfully${NC}"
        return 0
    else
        echo -e "${RED}❌ Failed to install $package${NC}"
        return 1
    fi
}

# Check and install required packages using common function
if ! check_and_install_packages "$PYTHON_CMD" \
    "flask" "flask" \
    "flask_cors" "flask-cors"; then
    exit 1
fi

# Set default port
PORT=${PORT:-5008}

# Get the directory of this script
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
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

# Check if port is already in use
if lsof -Pi :$PORT -sTCP:LISTEN -t >/dev/null ; then
    echo -e "${YELLOW}⚠️  Warning: Port $PORT is already in use${NC}"
    echo -e "${YELLOW}   Attempting to kill existing process...${NC}"
    
    # Kill existing process on the port
    PID=$(lsof -ti:$PORT)
    if [ ! -z "$PID" ]; then
        kill -9 $PID 2>/dev/null
        sleep 3
        
        # Verify the process is actually killed
        if lsof -Pi :$PORT -sTCP:LISTEN -t >/dev/null ; then
            echo -e "${RED}❌ Failed to kill process on port $PORT${NC}"
            exit 1
        fi
        
        echo -e "${GREEN}✅ Killed existing process on port $PORT${NC}"
    fi
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
