#!/bin/bash

# Directory to save PCM files
OUT_DIR="musical"
mkdir -p "$OUT_DIR"

SAMPLE_RATE=24000
DURATION=0.3  # 300ms tone duration

echo "🎵 Generating musical tone PCM files at 24kHz stereo..."

# Musical notes and their frequencies (Hz)
NOTES=(do re mi fa sol la ti high_do)
FREQUENCIES=(261.63 293.66 329.63 349.23 392.00 440.00 493.88 523.25)

# Generate each musical tone as 24kHz stereo PCM
for i in "${!NOTES[@]}"; do
    note="${NOTES[$i]}"
    freq="${FREQUENCIES[$i]}"
    temp_wav="$OUT_DIR/${note}_temp.wav"
    final_pcm="$OUT_DIR/${note}.pcm"

    echo "🎵 Generating: $note (${freq}Hz) → $final_pcm"
    
    # Step 1: Generate sine wave tone using sox
    sox -n -r $SAMPLE_RATE -c 1 "$temp_wav" synth $DURATION sine $freq vol 0.7
    
    if [ $? -eq 0 ] && [ -f "$temp_wav" ]; then
        # Step 2: Convert WAV to stereo PCM
        sox "$temp_wav" -t raw -r $SAMPLE_RATE -e signed -b 16 -c 2 "$final_pcm" channels 2
        
        if [ $? -eq 0 ]; then
            echo "✅ Generated: $final_pcm (24kHz stereo PCM)"
            # Step 3: Remove temporary WAV
            rm "$temp_wav"
        else
            echo "❌ Failed to convert $temp_wav to PCM"
        fi
    else
        echo "❌ Failed to generate tone for: $note"
    fi
done

echo "🎉 All musical tone PCM files generated at 24kHz stereo in $OUT_DIR" 