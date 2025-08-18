# Korean TTS Support

This document explains the Korean Text-to-Speech (TTS) feature added to LipCoder.

## Overview

LipCoder now automatically detects Korean text and uses OpenAI's TTS service to provide high-quality Korean speech synthesis. English and other text continues to use the selected TTS backend (Silero, espeak-ng, or OpenAI).

## Features

- **Automatic Language Detection**: Korean text is automatically detected using Unicode character ranges
- **OpenAI TTS Integration**: Korean text uses OpenAI's TTS service for natural-sounding speech
- **Mixed Language Support**: Handles text with both Korean and English characters
- **Caching**: Korean TTS audio is cached separately from English TTS to avoid conflicts
- **Fallback Support**: If Korean TTS fails, the system gracefully handles errors

## Setup

### 1. OpenAI API Key

Korean TTS requires an OpenAI API key. Set it up using one of these methods:

**Method A: VS Code Command Palette**
1. Open Command Palette (`Ctrl+Shift+P` or `Cmd+Shift+P`)
2. Type "LipCoder: Set OpenAI API Key"
3. Enter your OpenAI API key

**Method B: VS Code Settings**
1. Open VS Code Settings (`Ctrl+,` or `Cmd+,`)
2. Search for "lipcoder"
3. Set `lipcoder.openaiApiKey` to your API key

**Method C: Environment Variable**
Set the `OPENAI_API_KEY` environment variable before starting VS Code.

### 2. Configuration

The Korean TTS system uses these default settings:
- **Model**: `tts-1` (OpenAI's standard TTS model)
- **Voice**: `alloy` (can be changed to echo, fable, onyx, nova, shimmer)
- **Speed**: `1.0` (normal speed)
- **Language**: Automatically set to `ko` for Korean text, `en` for English text

You can customize these in VS Code settings:
- `lipcoder.openaiTTSModel`: TTS model (`tts-1` or `tts-1-hd`)
- `lipcoder.openaiTTSVoice`: Voice selection
- `lipcoder.openaiTTSSpeed`: Speech speed (0.25 to 4.0)

## How It Works

### Language Detection

The system detects Korean text using Unicode character ranges:
- **Hangul Syllables**: U+AC00-U+D7AF (가-힣)
- **Hangul Jamo**: U+1100-U+11FF (ᄀ-ᇿ)
- **Hangul Compatibility Jamo**: U+3130-U+318F (㄀-㆏)
- **Hangul Jamo Extended**: U+A960-U+A97F, U+D7B0-U+D7FF

### TTS Routing Logic

1. **Korean Text**: Automatically uses OpenAI TTS regardless of current TTS backend
2. **English Text**: Uses the currently selected TTS backend (Silero/espeak-ng/OpenAI)
3. **Mixed Text**: Determines dominant language; if Korean characters make up >30%, uses Korean TTS
4. **Numbers/Symbols**: Defaults to English TTS

### Examples

| Text | Language Detected | TTS Backend Used |
|------|------------------|------------------|
| `안녕하세요` | Korean | OpenAI TTS |
| `변수` | Korean | OpenAI TTS |
| `hello` | English | Current backend |
| `const 변수 = 'value'` | English (mixed) | Current backend |
| `안녕 world` | Korean (mixed) | OpenAI TTS |
| `123` | English | Current backend |

## Testing

### Test Command

Use the built-in test command to verify Korean TTS is working:

1. Open Command Palette (`Ctrl+Shift+P` or `Cmd+Shift+P`)
2. Type "LipCoder: Test Korean TTS"
3. The command will test several Korean and English phrases
4. Check the VS Code Developer Console for detailed logs

### Manual Testing

1. Open a file in VS Code
2. Type Korean text (e.g., `안녕하세요`, `변수`, `함수`)
3. Use LipCoder's reading features (line reading, token reading, etc.)
4. Korean text should be spoken with natural Korean pronunciation

## Troubleshooting

### Common Issues

**1. No Sound for Korean Text**
- Check if OpenAI API key is configured
- Verify API key has sufficient credits
- Check VS Code Developer Console for error messages

**2. Korean Text Uses Wrong Voice**
- Ensure the text is properly detected as Korean
- Check language detection logs in Developer Console
- Verify Unicode characters are in Korean ranges

**3. API Errors**
- Check internet connection
- Verify OpenAI API key is valid and has credits
- Check rate limits on OpenAI account

### Debug Information

Enable detailed logging by:
1. Open VS Code Developer Console (`Help > Toggle Developer Tools`)
2. Look for log messages starting with:
   - `[genTokenAudio] Language detection for`
   - `[generateOpenAITTS] Using OpenAI TTS for token`
   - `[genTokenAudio] Korean text detected`

### Test Language Detection

The system includes detailed logging for language detection:
```
[genTokenAudio] Language detection for "안녕하세요": ko, useKoreanTTS: true
[genTokenAudio] Korean text detected, using OpenAI TTS: "안녕하세요"
[generateOpenAITTS] Using OpenAI TTS for token "안녕하세요" with voice "alloy" and language "ko"
```

## File Structure

The Korean TTS feature adds these files:
- `client/src/language_detection.ts`: Language detection utilities
- `client/src/features/test_korean_tts.ts`: Test command for debugging
- Updates to `client/src/tts.ts`: TTS routing logic
- Updates to `client/src/config.ts`: OpenAI TTS configuration

## API Usage

Korean TTS uses OpenAI's Text-to-Speech API:
- **Endpoint**: `https://api.openai.com/v1/audio/speech`
- **Model**: `tts-1` or `tts-1-hd`
- **Format**: WAV (for compatibility with existing audio system)
- **Cost**: Approximately $0.015 per 1,000 characters

## Limitations

1. **Internet Required**: Korean TTS requires internet connection for OpenAI API
2. **API Costs**: Usage incurs OpenAI API charges
3. **Rate Limits**: Subject to OpenAI API rate limits
4. **Language Mixing**: Very short mixed-language text might not detect correctly

## Future Enhancements

Potential improvements:
- Support for other Korean TTS services
- Better mixed-language handling
- Korean-specific voice categories
- Offline Korean TTS options
- Korean speech recognition integration
