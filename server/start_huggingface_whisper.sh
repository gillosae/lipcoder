#!/bin/bash

# Hugging Face Whisper ASR Server Startup Script
# Uses local Hugging Face Transformers Whisper model

echo "🤗 Starting Hugging Face Whisper ASR Server..."

# Get the directory of this script
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_SCRIPT="$SCRIPT_DIR/huggingface_whisper_server.py"
PORT=5005

# Source Python utilities
source "$SCRIPT_DIR/python_utils.sh"

# Kill any existing processes on the port
kill_port_processes $PORT

echo "🐍 Setting up Python environment for Hugging Face Whisper..."

# Check for virtual environment first
VENV_PYTHON="$SCRIPT_DIR/lipcoder_venv/bin/python"
if [ -x "$VENV_PYTHON" ]; then
    echo "✅ Found virtual environment Python: $VENV_PYTHON"
    PYTHON_CMD="$VENV_PYTHON"
else
    echo "⚠️  Virtual environment not found, searching for system Python..."
    # Find Python with ML packages
    find_python_with_ml_packages
    
    if [ -z "$PYTHON_CMD" ]; then
        echo "❌ No suitable Python installation found"
        echo "   Please install Python with PyTorch and Transformers:"
        echo "   pip install torch torchaudio transformers flask"
        echo "   Or activate the virtual environment: source $SCRIPT_DIR/lipcoder_venv/bin/activate"
        exit 1
    fi
fi

echo "✅ Found Python: $PYTHON_CMD"
echo "🐍 Python version: $($PYTHON_CMD --version)"

# Check required packages
echo "🔍 Checking required packages..."
REQUIRED_PACKAGES=("torch" "torchaudio" "transformers" "flask" "numpy")
MISSING_PACKAGES=()

for package in "${REQUIRED_PACKAGES[@]}"; do
    if ! $PYTHON_CMD -c "import $package" 2>/dev/null; then
        MISSING_PACKAGES+=("$package")
    fi
done

if [ ${#MISSING_PACKAGES[@]} -ne 0 ]; then
    echo "❌ Missing required packages: ${MISSING_PACKAGES[*]}"
    echo "   Please install them with:"
    echo "   $PYTHON_CMD -m pip install ${MISSING_PACKAGES[*]}"
    exit 1
fi

echo "✅ All required packages found"

# Check PyTorch installation
echo "🔥 Checking PyTorch installation..."
TORCH_VERSION=$($PYTHON_CMD -c "import torch; print(torch.__version__)" 2>/dev/null)
if [ $? -eq 0 ]; then
    echo "✅ PyTorch version: $TORCH_VERSION"
    
    # Check CUDA availability
    CUDA_AVAILABLE=$($PYTHON_CMD -c "import torch; print(torch.cuda.is_available())" 2>/dev/null)
    if [ "$CUDA_AVAILABLE" = "True" ]; then
        CUDA_DEVICE=$($PYTHON_CMD -c "import torch; print(torch.cuda.get_device_name())" 2>/dev/null)
        echo "🎯 CUDA available: $CUDA_DEVICE"
    else
        echo "💻 Using CPU (CUDA not available)"
    fi
else
    echo "❌ PyTorch not properly installed"
    exit 1
fi

# Check Transformers version
TRANSFORMERS_VERSION=$($PYTHON_CMD -c "import transformers; print(transformers.__version__)" 2>/dev/null)
if [ $? -eq 0 ]; then
    echo "🤗 Transformers version: $TRANSFORMERS_VERSION"
else
    echo "❌ Transformers not properly installed"
    exit 1
fi

echo "📡 Starting server on port $PORT..."

# Start the server
echo "🚀 Hugging Face Whisper ASR Server starting on http://localhost:$PORT"
echo "📝 Logs will appear below..."
echo "   Press Ctrl+C to stop the server"

# Run the server
$PYTHON_CMD "$SERVER_SCRIPT"

# Check exit code
EXIT_CODE=$?
if [ $EXIT_CODE -ne 0 ]; then
    echo "❌ Server exited with error code $EXIT_CODE"
else
    echo "✅ Server stopped gracefully"
fi
