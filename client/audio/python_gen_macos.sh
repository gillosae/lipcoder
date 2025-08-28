#!/bin/bash

# macOS Native TTS Python Keywords Generation Script
# Generates Python keyword PCM files using macOS native 'say' command

# Directory to save PCM files
OUT_DIR="python_macos"
mkdir -p "$OUT_DIR"

# macOS TTS settings for keywords (using Daniel - male voice)
VOICE="Daniel"  # Male voice for keywords
RATE=200        # Words per minute
SAMPLE_RATE=24000

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${BLUE}🍎 Generating Python keyword PCM files using macOS native TTS...${NC}"
echo -e "${BLUE}Voice: ${VOICE}, Rate: ${RATE} WPM, Sample Rate: ${SAMPLE_RATE}Hz${NC}"

# Check if we're on macOS
if [[ "$OSTYPE" != "darwin"* ]]; then
    echo -e "${RED}❌ Error: This script requires macOS${NC}"
    exit 1
fi

# Check if 'say' command is available
if ! command -v say &> /dev/null; then
    echo -e "${RED}❌ Error: macOS 'say' command not found${NC}"
    exit 1
fi

# Python keywords
PYTHON_KEYWORDS=(
    "and" "as" "assert" "async" "await" "break" "class" "continue" "def" "del"
    "elif" "else" "except" "false" "finally" "for" "from" "global" "if" "import"
    "in" "is" "lambda" "none" "nonlocal" "not" "or" "pass" "raise" "return"
    "true" "try" "while" "with" "yield"
)

echo -e "${YELLOW}📝 Generating ${#PYTHON_KEYWORDS[@]} Python keyword sounds...${NC}"

# Generate each Python keyword as PCM
for keyword in "${PYTHON_KEYWORDS[@]}"; do
  temp_wav="$OUT_DIR/${keyword}_temp.wav"
  final_pcm="$OUT_DIR/${keyword}.pcm"

  echo -e "${BLUE}🔊 Generating: ${keyword} → ${final_pcm}${NC}"
  
  # Step 1: Generate WAV using macOS 'say' command
  say -v "$VOICE" -r "$RATE" -o "$temp_wav" --data-format=LEI16@${SAMPLE_RATE} "$keyword"
  
  if [ $? -eq 0 ] && [ -f "$temp_wav" ]; then
    # Step 2: Convert WAV to stereo PCM (macOS say outputs mono, convert to stereo)
    if command -v sox &> /dev/null; then
      sox "$temp_wav" -t raw -r "$SAMPLE_RATE" -e signed -b 16 -c 2 "$final_pcm" channels 2
    elif command -v ffmpeg &> /dev/null; then
      # Fallback to ffmpeg if sox is not available
      ffmpeg -i "$temp_wav" -ar "$SAMPLE_RATE" -ac 2 -f s16le "$final_pcm" -y -loglevel quiet
    else
      # Fallback: use afconvert (built into macOS)
      afconvert "$temp_wav" -f WAVE -d LEI16@${SAMPLE_RATE} -c 2 "${temp_wav%.wav}_stereo.wav"
      # Convert to raw PCM
      afconvert "${temp_wav%.wav}_stereo.wav" -f caff -d LEI16 "$final_pcm"
      rm "${temp_wav%.wav}_stereo.wav" 2>/dev/null
    fi
    
    if [ $? -eq 0 ] && [ -f "$final_pcm" ]; then
      echo -e "${GREEN}✅ Generated: ${final_pcm} (${SAMPLE_RATE}Hz stereo PCM)${NC}"
      # Remove temporary WAV
      rm "$temp_wav"
    else
      echo -e "${RED}❌ Failed to convert ${temp_wav} to PCM${NC}"
    fi
  else
    echo -e "${RED}❌ Failed to generate TTS for: ${keyword}${NC}"
  fi
done

echo -e "${GREEN}🎉 All Python keyword PCM files generated using macOS TTS in ${OUT_DIR}${NC}"
echo -e "${BLUE}📁 Files created: $(ls -1 "$OUT_DIR"/*.pcm 2>/dev/null | wc -l) PCM files${NC}"

# Show available macOS voices for reference
echo -e "${YELLOW}💡 Available macOS voices (use -v option to change):${NC}"
say -v '?' | head -5
echo "   ... and more. Use 'say -v ?' to see all available voices."