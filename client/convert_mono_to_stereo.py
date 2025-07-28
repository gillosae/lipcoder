#!/usr/bin/env python3
"""
Convert all mono audio files in the client/audio directory to stereo PCM format.
This enables proper panning functionality in the extension.
"""

import os
import sys
from pathlib import Path
from pydub import AudioSegment
import argparse

def find_wav_files(audio_root):
    """Find all .wav files in the audio directory structure."""
    wav_files = []
    for root, dirs, files in os.walk(audio_root):
        for file in files:
            if file.lower().endswith('.wav'):
                wav_files.append(os.path.join(root, file))
    return sorted(wav_files)

def is_mono(audio_file):
    """Check if an audio file is mono (1 channel)."""
    try:
        audio = AudioSegment.from_wav(audio_file)
        return audio.channels == 1
    except Exception as e:
        print(f"Error reading {audio_file}: {e}")
        return False

def convert_to_stereo(audio_file, backup=True):
    """Convert a mono audio file to stereo and save as PCM."""
    try:
        # Load the mono audio
        mono_audio = AudioSegment.from_wav(audio_file)
        
        if mono_audio.channels == 1:
            # Create backup if requested
            if backup:
                backup_path = audio_file + '.mono_backup'
                mono_audio.export(backup_path, format="wav")
                print(f"  Backup saved: {backup_path}")
            
            # Convert mono to stereo by duplicating the channel
            stereo_audio = AudioSegment.from_mono_audiosegments(mono_audio, mono_audio)
            
            # Change file extension from .wav to .pcm
            pcm_file = audio_file.rsplit('.wav', 1)[0] + '.pcm'
            
            # Export as raw PCM (16-bit signed, little-endian) at original sample rate
            # Keep original sample rate (typically 24kHz)
            stereo_audio.export(pcm_file, format="s16le")
            
            # Remove the original WAV file
            os.remove(audio_file)
            
            print(f"  ✓ Converted to stereo PCM: {stereo_audio.channels} channels, {stereo_audio.frame_rate}Hz, 16-bit")
            print(f"  📁 Saved as: {os.path.basename(pcm_file)}")
            return True
        else:
            print(f"  Already stereo ({mono_audio.channels} channels)")
            # If already stereo, still convert to PCM format at original sample rate
            pcm_file = audio_file.rsplit('.wav', 1)[0] + '.pcm'
            # Keep original sample rate
            stereo_audio = mono_audio
            stereo_audio.export(pcm_file, format="s16le")
            os.remove(audio_file)
            print(f"  📁 Converted WAV to PCM ({stereo_audio.frame_rate}Hz): {os.path.basename(pcm_file)}")
            return True
            
    except Exception as e:
        print(f"  ✗ Error converting {audio_file}: {e}")
        return False

def main():
    parser = argparse.ArgumentParser(description='Convert mono audio files to stereo PCM for panning support')
    parser.add_argument('--no-backup', action='store_true', help='Don\'t create backup files')
    parser.add_argument('--audio-dir', default='audio', help='Audio directory path (default: audio)')
    parser.add_argument('--dry-run', action='store_true', help='Show what would be converted without actually converting')
    args = parser.parse_args()

    # Find the audio directory
    script_dir = Path(__file__).parent
    audio_dir = script_dir / args.audio_dir
    
    if not audio_dir.exists():
        print(f"Error: Audio directory not found: {audio_dir}")
        print("Make sure you're running this script from the client directory")
        sys.exit(1)
    
    print(f"🎵 Mono to Stereo PCM Audio Converter")
    print(f"📁 Audio directory: {audio_dir}")
    print(f"💾 Backup files: {'No' if args.no_backup else 'Yes'}")
    print(f"🔍 Dry run: {'Yes' if args.dry_run else 'No'}")
    print(f"📄 Output format: 16-bit stereo PCM at original sample rate")
    print()

    # Find all .wav files
    wav_files = find_wav_files(audio_dir)
    print(f"Found {len(wav_files)} WAV files")
    
    if not wav_files:
        print("No WAV files found!")
        return
    
    # Check which files are mono
    mono_files = []
    print("\n📊 Analyzing audio files...")
    for wav_file in wav_files:
        rel_path = os.path.relpath(wav_file, audio_dir)
        if is_mono(wav_file):
            mono_files.append(wav_file)
            print(f"  📻 MONO: {rel_path}")
        else:
            print(f"  🎧 STEREO: {rel_path}")
    
    print(f"\n📈 Summary:")
    print(f"  Total files: {len(wav_files)}")
    print(f"  Mono files: {len(mono_files)}")
    print(f"  Stereo files: {len(wav_files) - len(mono_files)}")
    
    if not mono_files:
        print("\n🎉 All files are already stereo!")
        # Still offer to convert all WAV to PCM
        if input("Convert all WAV files to PCM format? (y/N): ").lower().startswith('y'):
            wav_files_to_convert = wav_files
        else:
            print("No conversion performed.")
            return
    else:
        wav_files_to_convert = mono_files
    
    if args.dry_run:
        print(f"\n🔍 DRY RUN: Would convert {len(wav_files_to_convert)} files to stereo PCM")
        return
    
    # Convert files to stereo PCM
    print(f"\n🔄 Converting {len(wav_files_to_convert)} files to stereo PCM...")
    converted_count = 0
    
    for i, audio_file in enumerate(wav_files_to_convert, 1):
        rel_path = os.path.relpath(audio_file, audio_dir)
        print(f"[{i}/{len(wav_files_to_convert)}] {rel_path}")
        
        if convert_to_stereo(audio_file, backup=not args.no_backup):
            converted_count += 1
    
    print(f"\n🎉 Conversion complete!")
    print(f"  ✓ Converted: {converted_count} files")
    print(f"  ✗ Failed: {len(wav_files_to_convert) - converted_count} files")
    print(f"  📄 All files converted to 16-bit stereo PCM format at original sample rate")
    
    if not args.no_backup:
        print(f"\n💾 Backup files created with .mono_backup extension")
        print(f"   You can delete them after testing: find {audio_dir} -name '*.mono_backup' -delete")

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n\n⚠️ Conversion interrupted by user")
        sys.exit(1)
    except ImportError as e:
        if "pydub" in str(e):
            print("❌ Error: pydub library not found")
            print("Install it with: pip install pydub")
            print("You may also need: brew install ffmpeg (on macOS)")
        else:
            print(f"❌ Import error: {e}")
        sys.exit(1) 