#!/bin/bash

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

# Source common Python utilities (ensure bash compatibility)
if [ -n "$BASH_VERSION" ]; then
    source "$SCRIPT_DIR/python_utils.sh"
else
    # If not bash, try to run with bash
    exec bash "$0" "$@"
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
