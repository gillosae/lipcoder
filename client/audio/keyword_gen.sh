#!/bin/bash

 # Create output directories
mkdir -p python
mkdir -p typescript

# Path to your TTS script
SCRIPT_PATH="../src/python/silero_tts_infer.py"

# Speaker and model info
LANGUAGE="en"
MODEL_ID="v3_en"
SPEAKER="en_1"


 # Declare arrays of keywords
PYTHON_KEYWORDS=(False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda match nonlocal not or pass raise return try while with yield)
TS_KEYWORDS=(abstract any as bigint boolean break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof let new null number object return static super switch symbol this throw true try type typeof undefined var void while with yield interface implements readonly private protected public module namespace declare constructor get set is key keyof unique unknown never)

# Generate Python keyword WAVs
for keyword in "${PYTHON_KEYWORDS[@]}"; do
  text="$keyword"
  filename=$(echo "$keyword" | tr '[:upper:]' '[:lower:]')
  output="python/${filename}.wav"

  echo "🔊 Generating Python keyword: $text → $output"
  ../src/python/bin/python3 "$SCRIPT_PATH" \
    --text "$text" \
    --language="$LANGUAGE" \
    --model_id="$MODEL_ID" \
    --output "$output" \
    --speaker "$SPEAKER"
done

# Generate TypeScript keyword WAVs
for keyword in "${TS_KEYWORDS[@]}"; do
  text="$keyword"
  filename=$(echo "$keyword" | tr '[:upper:]' '[:lower:]')
  output="typescript/${filename}.wav"

  echo "🔊 Generating TypeScript keyword: $text → $output"
  ../src/python/bin/python3 "$SCRIPT_PATH" \
    --text "$text" \
    --language="$LANGUAGE" \
    --model_id="$MODEL_ID" \
    --output "$output" \
    --speaker "$SPEAKER"
done

echo "✅ All WAV files generated in python and typescript directories"