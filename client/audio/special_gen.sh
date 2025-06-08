#!/bin/bash

# Directory to save WAVs
OUT_DIR="special"
mkdir -p "$OUT_DIR"

# Path to your TTS script
SCRIPT_PATH="../python/silero_tts_infer.py"

# Speaker and model info
LANGUAGE="en"
MODEL_ID="v3_en"
SPEAKER="en_3"

# Declare associative array: letter => pronunciation
PRONUNCIATIONS=('excitation' 'at' 'sharp' 'dollar' 'percent' 'caret' 'ampersand' 'asterisk' 'plus' 'tilde' 'bar' 'question' 'won' 'equals' 'backtick' 'backslash' 'dot' 'comma' 'underbar')


# Generate each WAV
for i in "${!PRONUNCIATIONS[@]}"; do
  letter="${PRONUNCIATIONS[$i]}"
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

