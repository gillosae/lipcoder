#!/bin/bash

# Directory to save PCM files
OUT_DIR="special"
mkdir -p "$OUT_DIR"

# Path to your TTS script
SCRIPT_PATH="../src/python/silero_tts_infer.py"

# Speaker and model info
LANGUAGE="en"
MODEL_ID="v3_en"  
SPEAKER="en_3"
SAMPLE_RATE=24000

# Special character pronunciations - format: "filename:text_to_speak"
PRONUNCIATIONS=(
  'excitation:excitation' 'at:at' 'sharp:sharp' 'dollar:dollar' 'percent:percent' 
  'caret:caret' 'ampersand:ampersand' 'asterisk:asterisk' 'plus:plus' 'tilde:tilde' 
  'bar:bar' 'question:question' 'won:won' 'equals:equals' 'backtick:backtick' 
  'backslash:backslash' 'dot:dot' 'comma:comma' 'underbar:underbar' 'dash:dash' 
  'colon:colon' 'slash:slash' 'slash_slash:slash slash' 'less_than_or_equal:less than or equal' 
  'greater_than_or_equal:greater than or equal' 'equals_equals:equals equals' 
  'not_equal:not equal' 'triple_equals:triple equals' 'not_triple_equals:not triple equals' 
  'and_and:and and' 'or_or:or or' 'plus_plus:plus plus' 'minus_minus:minus minus' 
  'plus_equals:plus equals' 'minus_equals:minus equals' 'times_equals:times equals' 
  'divide_equals:divide equals' 'arrow:arrow'
)

echo "🔧 Generating special character PCM files at 24kHz stereo..."

# Generate each special character as 24kHz stereo PCM
for pronunciation in "${PRONUNCIATIONS[@]}"; do
  IFS=':' read -r name text <<< "$pronunciation"
  temp_wav="$OUT_DIR/${name}_temp.wav"
  final_pcm="$OUT_DIR/${name}.pcm"

  echo "🔊 Generating: $name → \"$text\" → $final_pcm"
  
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
    echo "❌ Failed to generate TTS for: $name"
  fi
done

echo "🎉 All special character PCM files generated at 24kHz stereo in $OUT_DIR"

