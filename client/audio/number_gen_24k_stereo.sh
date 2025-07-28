#!/bin/bash

# Directory to save PCM files
OUT_DIR="number"
mkdir -p "$OUT_DIR"

# Path to your TTS script
SCRIPT_PATH="../src/python/silero_tts_infer.py"

# Speaker and model info
LANGUAGE="en"
MODEL_ID="v3_en"
SPEAKER="en_3"
SAMPLE_RATE=24000

# Declare associative array: number => pronunciation
NUMBERS=(0 1 2 3 4 5 6 7 8 9)
PRONUNCIATIONS=("zero" "one" "two" "three" "four" "five" "six" "seven" "eight" "nine")

echo "🔧 Generating number PCM files at 24kHz stereo..."

# Generate each number as 24kHz stereo PCM
for i in "${!NUMBERS[@]}"; do
  number="${NUMBERS[$i]}"
  text="${PRONUNCIATIONS[$i]}"
  temp_wav="$OUT_DIR/${number}_temp.wav"
  final_pcm="$OUT_DIR/${number}.pcm"

  echo "🔊 Generating: $number → \"$text\" → $final_pcm"
  
  # Step 1: Generate WAV at 24kHz
  ../src/python/bin/python3 "$SCRIPT_PATH" \
    --text "$text" \
    --language="$LANGUAGE" \
    --model_id="$MODEL_ID" \
    --output "$temp_wav" \
    --speaker "$SPEAKER" \
    --sample_rate "$SAMPLE_RATE"
  
  if [ $? -eq 0 ] && [ -f "$temp_wav" ]; then
    # Step 2: Convert WAV to stereo PCM (TTS output is mono, convert to stereo)
    sox "$temp_wav" -t raw -r 24000 -e signed -b 16 -c 2 "$final_pcm" channels 2
    
    if [ $? -eq 0 ]; then
      echo "✅ Generated: $final_pcm (24kHz stereo PCM)"
      # Step 3: Remove temporary WAV
      rm "$temp_wav"
    else
      echo "❌ Failed to convert $temp_wav to PCM"
    fi
  else
    echo "❌ Failed to generate TTS for: $number"
  fi
done

echo "🎉 All number PCM files generated at 24kHz stereo in $OUT_DIR"