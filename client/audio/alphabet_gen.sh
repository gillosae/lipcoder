#!/bin/bash

# Directory to save WAVs
OUT_DIR="alphabet"
mkdir -p "$OUT_DIR"

# Path to your TTS script
SCRIPT_PATH="../python/silero_tts_infer.py"

# Speaker and model info
LANGUAGE="en"
MODEL_ID="v3_en"
SPEAKER="en_3"

# Declare associative array: letter => pronunciation
LETTERS=(a b c d e f g h i j k l m n o p q r s t u v w x y z)
PRONUNCIATIONS=(ay beee seee dee ee eff gee aitch eye jay kay el em en oh peee cue ar ess teee you vee "double you" exx whhy zeee)

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