#!/bin/bash

# Directory to save PCM files
OUT_DIR="alphabet"
mkdir -p "$OUT_DIR"

# Path to your TTS script
SCRIPT_PATH="../src/python/silero_tts_infer.py"

# Speaker and model info
LANGUAGE="en"
MODEL_ID="v3_en"
SPEAKER="en_3"
SAMPLE_RATE=24000

# Declare associative array: letter => pronunciation
LETTERS=(a b c d e f g h i j k l m n o p q r s t u v w x y z)
PRONUNCIATIONS=(ay beee seee dee ee eff gee aitch eye jay kay el em en oh peee cue ar ess teee you vee "double you" exx whhy zeee)

echo "🔧 Generating alphabet PCM files at 24kHz stereo..."

# Generate each letter as 24kHz stereo PCM
for i in "${!LETTERS[@]}"; do
  letter="${LETTERS[$i]}"
  text="${PRONUNCIATIONS[$i]}"
  temp_wav="$OUT_DIR/${letter}_temp.wav"
  final_pcm="$OUT_DIR/${letter}.pcm"

  echo "🔊 Generating: $letter → \"$text\" → $final_pcm"
  
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
    echo "❌ Failed to generate TTS for: $letter"
  fi
done

echo "🎉 All alphabet PCM files generated at 24kHz stereo in $OUT_DIR"
