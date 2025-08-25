#!/usr/bin/env python3
"""
Convert MOV voice files to 16kHz mono WAV files for XTTS-v2 speaker cloning.
"""

import os
import subprocess
import sys
from pathlib import Path

def convert_mov_to_wav(input_file, output_file):
    """Convert MOV file to 16kHz mono WAV using ffmpeg."""
    try:
        cmd = [
            'ffmpeg',
            '-i', str(input_file),
            '-ar', '16000',  # 16kHz sample rate
            '-ac', '1',      # mono (1 channel)
            '-acodec', 'pcm_s16le',  # 16-bit PCM
            '-y',            # overwrite output file
            str(output_file)
        ]
        
        print(f"Converting {input_file.name} -> {output_file.name}")
        result = subprocess.run(cmd, capture_output=True, text=True)
        
        if result.returncode == 0:
            print(f"✅ Successfully converted {input_file.name}")
            return True
        else:
            print(f"❌ Error converting {input_file.name}: {result.stderr}")
            return False
            
    except FileNotFoundError:
        print("❌ ffmpeg not found. Please install ffmpeg:")
        print("   brew install ffmpeg")
        return False
    except Exception as e:
        print(f"❌ Error converting {input_file.name}: {e}")
        return False

def main():
    # Define paths
    voices_dir = Path(__file__).parent / "voices"
    
    if not voices_dir.exists():
        print(f"❌ Voices directory not found: {voices_dir}")
        sys.exit(1)
    
    # Find all MOV files
    mov_files = list(voices_dir.glob("*.mov"))
    
    if not mov_files:
        print("❌ No MOV files found in voices directory")
        sys.exit(1)
    
    print(f"Found {len(mov_files)} MOV files to convert:")
    for mov_file in mov_files:
        print(f"  - {mov_file.name}")
    
    print("\nStarting conversion...")
    
    success_count = 0
    for mov_file in mov_files:
        # Create output filename (same name but .wav extension)
        wav_file = mov_file.with_suffix('.wav')
        
        if convert_mov_to_wav(mov_file, wav_file):
            success_count += 1
    
    print(f"\n🎉 Conversion complete: {success_count}/{len(mov_files)} files converted successfully")
    
    if success_count > 0:
        print("\nConverted WAV files:")
        for wav_file in voices_dir.glob("*.wav"):
            size_mb = wav_file.stat().st_size / (1024 * 1024)
            print(f"  - {wav_file.name} ({size_mb:.1f} MB)")

if __name__ == "__main__":
    main()
