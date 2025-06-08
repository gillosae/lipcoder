#!/bin/bash

# Directory to save WAVs
OUT_DIR="number"
mkdir -p "$OUT_DIR"

# Path to your TTS script
SCRIPT_PATH="../python/silero_tts_infer.py"

# Speaker and model info
LANGUAGE="en"
MODEL_ID="v3_en"
SPEAKER="en_3"

# Declare associative array: letter => pronunciation
LETTERS=(0 1 2 3 4 5 6 7 8 9)
PRONUNCIATIONS=("zero" "one" "two" "three" "four" "five" "six" "seven" "eight" "nine")

# Generate each WAV
for i in "${!LETTERS[@]}"; do
  letter="${LETTERS[$i]}"
  text="${PRONUNCIATIONS[$i]}"
  output="$OUT_DIR/${letter}.wav"

  echo "🔊 Generating: $letter → \"$text\" → $output"
  ../python/bin/python3 "$SCRIPT_PATH" \
    --text "$text" \
    --language="$LANGUAGE" \
    --model_id="$MODEL_ID" \
    --output "$output" \
    --speaker "$SPEAKER"
done

echo "✅ All WAV files generated in $OUT_DIR"