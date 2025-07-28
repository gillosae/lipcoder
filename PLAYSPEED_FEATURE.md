# Global Playspeed Feature with Pitch Preservation

## Overview
The global playspeed feature allows you to adjust the playback speed of ALL audio in LipCoder, including earcons, TTS (text-to-speech), and special character sounds. **NEW**: Now supports pitch-preserving time stretching using FFmpeg!

## How to Use

### 1. Command Palette
Open the command palette (`Cmd+Shift+P` on Mac, `Ctrl+Shift+P` on Windows/Linux) and search for:

**Main Commands:**
- **"LipCoder: Set Playback Speed"** - Custom speed with input validation and pitch preservation info
- **"LipCoder: Toggle Pitch Preservation"** - 🎵 Enable/disable pitch-preserving time stretching

**Quick Presets:**
- **"LipCoder: Set Playback Speed - Slow (0.8×)"** - Quick preset for slower playback  
- **"LipCoder: Set Playback Speed - Normal (1.0×)"** - Reset to normal speed
- **"LipCoder: Set Playback Speed - Fast (1.5×)"** - Quick preset for faster playback
- **"LipCoder: Set Playback Speed - Very Fast (2.0×)"** - Quick preset for very fast playback

### 2. Configuration
- **`config.playSpeed`** (defaults to 1.4×) - Global playback speed multiplier
- **`config.preservePitch`** (defaults to true) - Enable pitch-preserving time stretching

## Pitch Preservation Options

### 🎵 Pitch-Preserving Mode (Recommended - Default: ON)
- **Uses**: FFmpeg's `atempo` filter for professional-quality time stretching
- **Result**: Speed changes while **pitch stays constant** - no chipmunk effect!
- **Pros**: 
  - Natural-sounding speech at any speed
  - Professional audio quality
  - Works with all audio types (earcons, TTS, special chars)
- **Cons**: 
  - Requires FFmpeg (usually pre-installed on Mac/Linux)
  - Slightly more processing overhead
  - Uses temporary files for processing

### 🎤 Sample Rate Mode (Legacy - Default: OFF)
- **Uses**: Simple sample rate adjustment
- **Result**: Speed and pitch change together (higher speed = higher pitch)
- **Pros**: 
  - Very fast processing
  - No external dependencies
  - Lower memory usage
- **Cons**: 
  - Chipmunk effect at high speeds
  - Unnatural-sounding speech
  - Hard to understand at extreme speeds

## Speed Limits & Performance

### Speed Ranges
- **Minimum**: 0.1× (very slow)
- **Maximum**: 3.0× (very fast)
- **Default**: 1.4× (40% faster than normal)
- **Recommended**: 0.5× to 2.5× for best quality

### FFmpeg Chaining
For extreme speeds, the system automatically chains multiple `atempo` filters:
- Single `atempo` filter: 0.5× to 2.0×
- Multiple filters: Outside this range (e.g., 3.0× = `atempo=2.0,atempo=1.5`)

## Technical Implementation

### Architecture
1. **Global Config**: Uses `config.playSpeed` and `config.preservePitch`
2. **Smart Routing**: 
   - If `preservePitch = true` → FFmpeg time stretching
   - If `preservePitch = false` → Sample rate adjustment
3. **Caching**: Time-stretched files are cached in `/tmp/lipcoder_timestretch/`
4. **Fallback**: If FFmpeg fails, automatically falls back to sample rate adjustment
5. **All Audio Types**: Works with `playWave()`, `playEarcon()`, `playTtsAsPcm()`, and `playPcmCached()`

### FFmpeg Command
```bash
ffmpeg -i input.wav -af "atempo=1.5" -y output.wav
```

For extreme speeds:
```bash
ffmpeg -i input.wav -af "atempo=2.0,atempo=1.5" -y output.wav  # 3.0x speed
```

## Compatibility & Requirements

### Requirements for Pitch Preservation
- **FFmpeg**: Must be installed and available in PATH
- **Check availability**: Run `which ffmpeg` (Mac/Linux) or `where ffmpeg` (Windows)
- **Install**: 
  - Mac: `brew install ffmpeg`
  - Linux: `apt install ffmpeg` or `yum install ffmpeg`
  - Windows: Download from https://ffmpeg.org/

### Fallback Behavior
- If FFmpeg is not available, automatically uses sample rate adjustment
- If FFmpeg fails for a specific file, falls back gracefully
- No crashes or errors - always plays audio in some form

## User Experience

### Smart UI Messages
- Commands show current pitch preservation status
- Speed presets indicate pitch behavior: "(pitch preserved)" or "(higher pitch)"
- Clear feedback about FFmpeg availability and fallback usage

### Example Messages
```
🎵 LipCoder playback speed set to 1.5× (affects all audio: earcons, TTS, special characters)
🎵 Pitch preserved!

🎵 LipCoder pitch preservation enabled
Uses FFmpeg time stretching - pitch stays constant when changing speed
```

## Troubleshooting

### FFmpeg Not Found
- **Error**: Falls back to sample rate adjustment
- **Solution**: Install FFmpeg and restart VS Code
- **Check**: Run `ffmpeg -version` in terminal

### Performance Issues
- **Large files**: First-time processing may take a moment
- **Caching**: Subsequent playback is instant (cached results)
- **Memory**: Temporary files are automatically cleaned up

### Audio Quality
- **Best quality**: Keep speeds between 0.5× and 2.5×
- **Extreme speeds**: May introduce slight artifacts but maintains pitch
- **Fallback quality**: Sample rate mode works but changes pitch

## Migration from Legacy

### Automatic Migration
- Existing installations automatically get `preservePitch: true`
- No changes needed - everything works better immediately!
- Old behavior available via "Toggle Pitch Preservation" command

### Benefits Over Legacy
- **Natural speech**: No more chipmunk voices
- **Better comprehension**: Maintain speech clarity at any speed
- **Professional quality**: Same algorithms used in audio editing software 