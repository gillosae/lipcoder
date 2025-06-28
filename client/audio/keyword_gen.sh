#!/bin/bash

 # Create output directories

NUMERO=80

PYTHONDIR="python${NUMERO}"
TYPESCRIPTDIR="typescript${NUMERO}"

mkdir -p "$PYTHONDIR"
mkdir -p "$TYPESCRIPTDIR"

# Path to your TTS script
SCRIPT_PATH="../src/python/silero_tts_infer.py"

# Speaker and model info
LANGUAGE="en"
MODEL_ID="v3_en"
SPEAKER="en_${NUMERO}"


 # Declare arrays of keywords
PYTHON_KEYWORDS=(False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda match nonlocal not or pass raise return try while with yield)
PYTHON_KEYWORDS_PRONUNCIATIONS=(False None True and as assert uhsynk await break class continue deaf del ellif else except finally for from global if import in is lambda match nonlocal not or pass raise return try while with yield)

TS_KEYWORDS=(abstract any as bigint boolean break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof let new null number object return static super switch symbol this throw true try type typeof undefined var void while with yield interface implements readonly private protected public module namespace declare constructor get set is key keyof unique unknown never)
TS_KEYWORDS_PRONUNCIATIONS=(abstract any as bigint boolean break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof let new null number object return static super switch symbol this throw true try type typeof undefined var void while with yield interface implements readonly private protected public module namespace declare constructor get set is key keyof unique unknown never)

# Generate Python keyword WAVs with custom pronunciations
for i in "${!PYTHON_KEYWORDS[@]}"; do
  keyword="${PYTHON_KEYWORDS[i]}"
  pron="${PYTHON_KEYWORDS_PRONUNCIATIONS[i]}"
  filename=$(echo "$keyword" | tr '[:upper:]' '[:lower:]')
  output="${PYTHONDIR}/${filename}.wav"

  echo "🔊 Generating Python keyword: \"$keyword\" → pronounce as \"$pron\" → $output"
  ../src/python/bin/python3 "$SCRIPT_PATH" \
    --text "$pron" \
    --language="$LANGUAGE" \
    --model_id="$MODEL_ID" \
    --output "$output" \
    --speaker "$SPEAKER"
done

# Generate TypeScript keyword WAVs with custom pronunciations
for i in "${!TS_KEYWORDS[@]}"; do
  keyword="${TS_KEYWORDS[i]}"
  pron="${TS_KEYWORDS_PRONUNCIATIONS[i]}"
  filename=$(echo "$keyword" | tr '[:upper:]' '[:lower:]')
  output="${TYPESCRIPTDIR}/${filename}.wav"

  echo "🔊 Generating TypeScript keyword: \"$keyword\" → pronounce as \"$pron\" → $output"
  ../src/python/bin/python3 "$SCRIPT_PATH" \
    --text "$pron" \
    --language="$LANGUAGE" \
    --model_id="$MODEL_ID" \
    --output "$output" \
    --speaker "$SPEAKER"
done

echo "✅ All WAV files generated in python and typescript directories"