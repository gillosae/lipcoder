#!/bin/bash

# macOS Native TTS Special Characters Generation Script
# Generates special character PCM files using macOS native 'say' command

# Directory to save PCM files
OUT_DIR="special_macos"
mkdir -p "$OUT_DIR"

# macOS TTS settings
VOICE="Yuna"  # Default macOS voice (Yuna supports Korean and English)
RATE=200      # Words per minute
SAMPLE_RATE=24000

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${BLUE}🍎 Generating special character PCM files using macOS native TTS...${NC}"
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

# Declare arrays: filename => pronunciation
SPECIAL_CHARS=(excitation at sharp dollar percent caret ampersand asterisk plus tilde bar question won equals backtick backslash minus dot comma underbar squarebracket)
PRONUNCIATIONS=(excitation at sharp dollar percent caret ampersand asterisk plus tilde bar question won equals backtick backslash minus dot comma underbar "square bracket")

# Multi-character operators
MULTI_CHARS=(plus_plus minus_minus plus_equals minus_equals times_equals divide_equals equals_equals not_equal triple_equals not_triple_equals less_than_or_equal greater_than_or_equal and_and or_or slash_slash arrow)
MULTI_PRONUNCIATIONS=("plus plus" "minus minus" "plus equals" "minus equals" "times equals" "divide equals" "equals equals" "not equal" "triple equals" "not triple equals" "less than or equal" "greater than or equal" "and and" "or or" "slash slash" "arrow")

echo -e "${YELLOW}📝 Generating ${#SPECIAL_CHARS[@]} special character sounds...${NC}"

# Generate each special character as PCM
for i in "${!SPECIAL_CHARS[@]}"; do
  char="${SPECIAL_CHARS[$i]}"
  text="${PRONUNCIATIONS[$i]}"
  temp_wav="$OUT_DIR/${char}_temp.wav"
  final_pcm="$OUT_DIR/${char}.pcm"

  echo -e "${BLUE}🔊 Generating: ${char} → \"${text}\" → ${final_pcm}${NC}"
  
  # Step 1: Generate WAV using macOS 'say' command
  say -v "$VOICE" -r "$RATE" -o "$temp_wav" --data-format=LEI16@${SAMPLE_RATE} "$text"
  
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
    echo -e "${RED}❌ Failed to generate TTS for: ${char}${NC}"
  fi
done

echo -e "${YELLOW}📝 Generating ${#MULTI_CHARS[@]} multi-character operator sounds...${NC}"

# Generate each multi-character operator as PCM
for i in "${!MULTI_CHARS[@]}"; do
  char="${MULTI_CHARS[$i]}"
  text="${MULTI_PRONUNCIATIONS[$i]}"
  temp_wav="$OUT_DIR/${char}_temp.wav"
  final_pcm="$OUT_DIR/${char}.pcm"

  echo -e "${BLUE}🔊 Generating: ${char} → \"${text}\" → ${final_pcm}${NC}"
  
  # Step 1: Generate WAV using macOS 'say' command
  say -v "$VOICE" -r "$RATE" -o "$temp_wav" --data-format=LEI16@${SAMPLE_RATE} "$text"
  
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
    
    if [ -f "$final_pcm" ]; then
      echo -e "${GREEN}✅ Generated: ${final_pcm} (${SAMPLE_RATE}Hz stereo PCM)${NC}"
      # Remove temporary WAV
      rm "$temp_wav"
    else
      echo -e "${RED}❌ Failed to convert ${temp_wav} to PCM${NC}"
    fi
  else
    echo -e "${RED}❌ Failed to generate TTS for: ${char}${NC}"
  fi
done

echo -e "${GREEN}🎉 All special character and multi-character operator PCM files generated using macOS TTS in ${OUT_DIR}${NC}"
echo -e "${BLUE}📁 Files created: $(ls -1 "$OUT_DIR"/*.pcm 2>/dev/null | wc -l) PCM files${NC}"

# Show available macOS voices for reference
echo -e "${YELLOW}💡 Available macOS voices (use -v option to change):${NC}"
say -v '?' | head -5
echo "   ... and more. Use 'say -v ?' to see all available voices."
