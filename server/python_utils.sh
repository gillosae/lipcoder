#!/bin/bash

# Python Utility Functions for LipCoder Server Scripts
# This file provides common Python detection and package installation functions

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to find Python with ML packages already installed
find_python_with_ml_packages() {
    # Try different Python executables and check if they have ML packages
    local python_candidates=(
        "python3.10"
        "python3.11" 
        "python3.12"
        "python3.9"
        "python3.13"
        "python3"
        "python"
    )
    
    # Also try common installation paths
    local python_paths=(
        "/opt/homebrew/bin/python3.10"
        "/opt/homebrew/bin/python3.11"
        "/opt/homebrew/opt/python@3.10/bin/python3"
        "/opt/homebrew/opt/python@3.11/bin/python3"
        "/opt/homebrew/bin/python3"
        "/opt/homebrew/bin/python3.12"
        "/opt/homebrew/bin/python3.13"
        "/opt/homebrew/opt/python@3.12/bin/python3"
        "/opt/homebrew/opt/python@3.13/bin/python3"
        "/usr/local/bin/python3"
        "/usr/bin/python3"
        "/bin/python3"
    )
    
    # First try to find Python with torch already installed
    echo -e "${BLUE}🔍 Looking for Python with ML packages already installed...${NC}" >&2
    
    # Check candidates in PATH first
    for python_cmd in "${python_candidates[@]}"; do
        if command -v "$python_cmd" &> /dev/null; then
            # Check if it's Python 3.8+
            local version=$($python_cmd --version 2>&1 | grep -oE '[0-9]+\.[0-9]+' | head -1)
            local major=$(echo $version | cut -d. -f1)
            local minor=$(echo $version | cut -d. -f2)
            
            if [ "$major" -ge 3 ] && [ "$minor" -ge 8 ]; then
                # Check if torch is already installed
                if $python_cmd -c "import torch" &> /dev/null; then
                    echo -e "${GREEN}✅ Found Python with torch: $python_cmd${NC}" >&2
                    echo "$python_cmd"
                    return 0
                fi
            fi
        fi
    done
    
    # Check specific paths
    for python_path in "${python_paths[@]}"; do
        if [ -x "$python_path" ]; then
            local version=$($python_path --version 2>&1 | grep -oE '[0-9]+\.[0-9]+' | head -1)
            local major=$(echo $version | cut -d. -f1)
            local minor=$(echo $version | cut -d. -f2)
            
            if [ "$major" -ge 3 ] && [ "$minor" -ge 8 ]; then
                # Check if torch is already installed
                if $python_path -c "import torch" &> /dev/null; then
                    echo -e "${GREEN}✅ Found Python with torch: $python_path${NC}" >&2
                    echo "$python_path"
                    return 0
                fi
            fi
        fi
    done
    
    echo -e "${YELLOW}⚠️  No Python with torch found, will use any available Python${NC}" >&2
    return 1
}

# Function to find any suitable Python
find_python() {
    # First try to find Python with ML packages
    local python_with_ml=$(find_python_with_ml_packages)
    if [ $? -eq 0 ] && [ ! -z "$python_with_ml" ]; then
        echo "$python_with_ml"
        return 0
    fi
    
    # If no Python with ML packages found, find any suitable Python
    local python_candidates=(
        "python3.10"
        "python3.11" 
        "python3.12"
        "python3.9"
        "python3.13"
        "python3"
        "python"
    )
    
    local python_paths=(
        "/opt/homebrew/bin/python3.10"
        "/opt/homebrew/bin/python3.11"
        "/opt/homebrew/opt/python@3.10/bin/python3"
        "/opt/homebrew/opt/python@3.11/bin/python3"
        "/opt/homebrew/bin/python3"
        "/opt/homebrew/bin/python3.12"
        "/opt/homebrew/bin/python3.13"
        "/opt/homebrew/opt/python@3.12/bin/python3"
        "/opt/homebrew/opt/python@3.13/bin/python3"
        "/usr/local/bin/python3"
        "/usr/bin/python3"
        "/bin/python3"
    )
    
    # Try candidates in PATH
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
    
    # Try specific paths
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

# Function to install package with proper error handling
install_package() {
    local python_cmd=$1
    local package=$2
    local pip_name=${3:-$package}
    
    echo -e "${YELLOW}📦 Installing $package...${NC}" >&2
    
    # Try different installation methods in order of preference
    local install_methods=(
        "$python_cmd -m pip install \"$pip_name\" --break-system-packages"
        "$python_cmd -m pip install \"$pip_name\" --user"
        "$python_cmd -m pip install \"$pip_name\""
        "pip3 install \"$pip_name\" --break-system-packages"
        "pip3 install \"$pip_name\" --user"
        "pip3 install \"$pip_name\""
    )
    
    for method in "${install_methods[@]}"; do
        if eval "$method" &> /dev/null; then
            echo -e "${GREEN}✅ $package installed successfully${NC}" >&2
            return 0
        fi
    done
    
    echo -e "${RED}❌ Failed to install $package${NC}" >&2
    return 1
}

# Function to install packages from requirements.txt
install_from_requirements() {
    local python_cmd=$1
    local requirements_file=$2
    
    if [ ! -f "$requirements_file" ]; then
        echo -e "${YELLOW}⚠️  Requirements file not found: $requirements_file${NC}" >&2
        return 1
    fi
    
    echo -e "${BLUE}📋 Installing packages from $requirements_file...${NC}" >&2
    
    # Try different installation methods
    local install_methods=(
        "$python_cmd -m pip install -r \"$requirements_file\" --break-system-packages"
        "$python_cmd -m pip install -r \"$requirements_file\" --user"
        "$python_cmd -m pip install -r \"$requirements_file\""
    )
    
    for method in "${install_methods[@]}"; do
        if eval "$method" &> /dev/null; then
            echo -e "${GREEN}✅ All packages from requirements.txt installed successfully${NC}" >&2
            return 0
        fi
    done
    
    echo -e "${RED}❌ Failed to install packages from requirements.txt${NC}" >&2
    return 1
}

# Function to check and install required packages
check_and_install_packages() {
    local python_cmd=$1
    shift  # Remove first argument (python_cmd)
    
    # Parse remaining arguments as associative array pairs
    declare -A required_packages
    while [[ $# -gt 0 ]]; do
        local package=$1
        local pip_name=${2:-$package}
        required_packages["$package"]="$pip_name"
        shift 2
    done
    
    echo -e "${BLUE}🔍 Checking required packages...${NC}" >&2
    
    local missing_packages=()
    for package in "${!required_packages[@]}"; do
        if [ "$package" != "subprocess" ] && ! $python_cmd -c "import $package" &> /dev/null; then
            missing_packages+=("$package")
        fi
    done
    
    if [ ${#missing_packages[@]} -gt 0 ]; then
        echo -e "${YELLOW}⚠️  Missing packages detected: ${missing_packages[*]}${NC}" >&2
        echo -e "${BLUE}🔄 Installing missing packages...${NC}" >&2
        
        for package in "${missing_packages[@]}"; do
            local pip_name="${required_packages[$package]}"
            if ! install_package "$python_cmd" "$package" "$pip_name"; then
                echo -e "${RED}❌ Error: Failed to install required package '$package'${NC}" >&2
                echo -e "${YELLOW}💡 Manual installation commands:${NC}" >&2
                echo -e "${YELLOW}   $python_cmd -m pip install $pip_name${NC}" >&2
                echo -e "${YELLOW}   or: $python_cmd -m pip install $pip_name --user${NC}" >&2
                return 1
            fi
        done
        
        echo -e "${GREEN}✅ All missing packages installed successfully${NC}" >&2
    else
        echo -e "${GREEN}✅ All required packages found${NC}" >&2
    fi
    
    return 0
}

# Function to setup Python environment
setup_python_environment() {
    local server_name=$1
    
    echo -e "${BLUE}🐍 Setting up Python environment for $server_name...${NC}" >&2
    
    # Find Python executable
    local python_cmd=$(find_python)
    
    if [ $? -ne 0 ] || [ -z "$python_cmd" ]; then
        echo -e "${RED}❌ Error: Could not find Python 3.8+ installation${NC}" >&2
        echo -e "${YELLOW}💡 Please install Python 3.8 or higher:${NC}" >&2
        echo -e "${YELLOW}   • macOS: brew install python${NC}" >&2
        echo -e "${YELLOW}   • Or download from: https://python.org${NC}" >&2
        return 1
    fi
    
    echo -e "${GREEN}✅ Found Python: $python_cmd${NC}" >&2
    
    # Check Python version
    local python_version=$($python_cmd --version 2>&1)
    echo -e "${BLUE}🐍 Python version: $python_version${NC}" >&2
    
    # Return the python command for use by calling script (stdout only)
    echo "$python_cmd"
    return 0
}
