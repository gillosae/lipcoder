#!/bin/bash

# Create output directory
TESTDIR="testdir"
mkdir -p "$TESTDIR"

# Path to your TTS script
SCRIPT_PATH="../src/python/silero_tts_infer.py"

# Speaker and model info (language & model stay constant)
LANGUAGE="en"
MODEL_ID="v3_en"

# Your three test sentences
declare -A TEST_SENTENCES=(
  [a]="She says she has the ability to hear the soundtrack of your life."
  [b]="The pet shop stocks everything you need to keep your anaconda happy."
  [c]="Courage and stupidity were all he had."
)

# Loop through voices 1 to 117
for NUMERO in $(seq 1 117); do
  SPEAKER="en_${NUMERO}"

  # For each sentence index (a, b, c)
  for idx in "${!TEST_SENTENCES[@]}"; do
    text="${TEST_SENTENCES[$idx]}"
    outfile="${TESTDIR}/speaker${NUMERO}_${idx}.wav"

    echo "🔊 Generating voice #${NUMERO}, sentence ${idx} → $outfile"
    ../src/python/bin/python3 "$SCRIPT_PATH" \
      --text "$text" \
      --language "$LANGUAGE" \
      --model_id "$MODEL_ID" \
      --output "$outfile" \
      --speaker "$SPEAKER"
  done
done

echo "✅ All test WAVs generated in $TESTDIR"