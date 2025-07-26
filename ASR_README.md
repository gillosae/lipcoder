# LipCoder ASR (Automatic Speech Recognition) Streaming

This document describes the ASR streaming functionality that allows real-time speech-to-text conversion using the Silero ASR server.

## Overview

The ASR system consists of:
1. **Silero ASR Server** - Python Flask server running on port 5005
2. **ASR Client** - TypeScript client for streaming microphone audio
3. **VS Code Integration** - Commands for controlling ASR streaming
4. **Browser Test Page** - HTML page for testing ASR functionality

## Prerequisites

1. **Silero ASR Server Running**: Make sure the ASR server is running on port 5005
   ```bash
   cd server
   gunicorn --workers 2 --bind 0.0.0.0:5005 silero_asr_server:app
   ```

2. **Microphone Access**: The browser/VS Code will request microphone permissions

## Features

### Real-time Audio Streaming
- Captures microphone audio in 2-second chunks
- Converts audio to WAV format (16kHz, mono, 16-bit)
- Sends chunks to Silero ASR server for transcription
- Receives real-time transcription results

### VS Code Integration
- **Start ASR Streaming**: `lipcoder.startASRStreaming`
- **Stop ASR Streaming**: `lipcoder.stopASRStreaming`
- **Toggle ASR Streaming**: `lipcoder.toggleASRStreaming`
- **Show ASR Output**: `lipcoder.showASROutput`
- **Clear ASR Output**: `lipcoder.clearASROutput`

### Browser Testing
- Open `client/test_asr.html` in a web browser
- Click "Start ASR Streaming" to begin
- View real-time transcriptions in the output area

## Usage

### In VS Code

1. **Start ASR Streaming**:
   - Press `Ctrl+Shift+P` (or `Cmd+Shift+P` on Mac)
   - Type "Start ASR Streaming"
   - Select the command
   - Grant microphone permissions when prompted

2. **View Transcriptions**:
   - Transcriptions appear as notifications
   - Use "Show ASR Output" to see all transcriptions in output panel

3. **Stop ASR Streaming**:
   - Use "Stop ASR Streaming" command
   - Or use "Toggle ASR Streaming" to switch on/off

### In Browser

1. **Open Test Page**:
   ```bash
   # Serve the test page (you can use any HTTP server)
   cd client
   python -m http.server 8080
   ```

2. **Access the Page**:
   - Open `http://localhost:8080/test_asr.html`
   - Click "Start ASR Streaming"
   - Speak into your microphone
   - View transcriptions in real-time

## Configuration

### ASR Client Options

```typescript
interface ASROptions {
    chunkDuration?: number;     // Duration of each audio chunk (ms)
    sampleRate?: number;        // Audio sample rate (default: 16000)
    serverUrl?: string;         // ASR server URL (default: http://localhost:5005/asr)
    onTranscription?: (chunk: ASRChunk) => void;  // Callback for transcriptions
    onError?: (error: Error) => void;             // Error callback
}
```

### Example Usage

```typescript
import { ASRClient } from './asr';

const asrClient = new ASRClient({
    chunkDuration: 2000,  // 2 seconds per chunk
    sampleRate: 16000,    // 16kHz
    serverUrl: 'http://localhost:5005/asr',
    onTranscription: (chunk) => {
        console.log(`Transcription: ${chunk.text}`);
    },
    onError: (error) => {
        console.error(`ASR Error: ${error.message}`);
    }
});

// Start streaming
await asrClient.startStreaming();

// Stop streaming
asrClient.stopStreaming();
```

## Technical Details

### Audio Processing Pipeline

1. **Microphone Capture**: Uses `navigator.mediaDevices.getUserMedia()`
2. **Audio Context**: Creates Web Audio API context at 16kHz
3. **Chunking**: Accumulates audio data in 2-second chunks
4. **WAV Conversion**: Converts Float32Array to WAV format
5. **Server Communication**: Sends WAV blobs to ASR server via FormData
6. **Transcription**: Receives JSON response with transcribed text

### Audio Format

- **Sample Rate**: 16kHz (required by Silero)
- **Channels**: Mono (1 channel)
- **Bit Depth**: 16-bit
- **Format**: WAV with proper headers

### Error Handling

- Microphone permission errors
- Network connectivity issues
- ASR server errors
- Audio processing errors

## Troubleshooting

### Common Issues

1. **"Microphone permission denied"**:
   - Grant microphone permissions in browser/VS Code
   - Check system microphone settings

2. **"ASR server error"**:
   - Ensure Silero ASR server is running on port 5005
   - Check server logs for errors
   - Verify network connectivity

3. **"No transcription received"**:
   - Check microphone is working
   - Ensure speaking clearly and loudly enough
   - Verify audio chunk size is appropriate

4. **"Audio context error"**:
   - Check browser compatibility
   - Ensure HTTPS for production use
   - Try refreshing the page

### Debug Mode

Enable debug logging by setting the log level:

```typescript
// In VS Code extension
log('[ASR] Debug mode enabled');
```

## Performance Considerations

- **Chunk Duration**: 2 seconds provides good balance between latency and accuracy
- **Sample Rate**: 16kHz is optimal for Silero model
- **Network**: Local server minimizes latency
- **Memory**: Audio chunks are processed and cleared immediately

## Security Notes

- Microphone access requires user permission
- Audio data is sent to local ASR server only
- No audio data is stored permanently
- HTTPS required for production deployment

## Future Enhancements

- [ ] Support for different languages
- [ ] Confidence scores in transcriptions
- [ ] Custom audio preprocessing
- [ ] Offline ASR capabilities
- [ ] Integration with voice commands
- [ ] Real-time audio visualization 