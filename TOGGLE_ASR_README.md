# LipCoder Toggle ASR Feature

This document describes the toggle ASR (Automatic Speech Recognition) feature that allows easy on/off control of speech-to-text streaming using a browser-based approach.

## Features

### 🎤 **Toggle ASR Command**
- **Command**: `lipcoder.toggleASR`
- **Keyboard Shortcut**: `Ctrl+Shift+A` (Windows/Linux) or `Cmd+Shift+A` (Mac)
- **Status Bar**: Shows current ASR status with microphone icon

### 📊 **Status Bar Integration**
- **ASR OFF**: Shows `$(mic) ASR OFF` in status bar
- **ASR ON**: Shows `$(mic) ASR ON` with highlighted background
- **Clickable**: Click the status bar item to toggle ASR

### 🌐 **Browser-Based Audio Capture**
- **Test Page**: `http://localhost:8080/test_asr.html`
- **Microphone Access**: Browser handles microphone permissions
- **Real-time Streaming**: Continuous audio capture and transcription
- **VS Code Integration**: Notifications and output panel integration

### 🔧 **Additional Commands**
- `lipcoder.getASRStatus` - Check current ASR status
- `lipcoder.showASROutput` - Show transcription output panel
- `lipcoder.clearASROutput` - Clear transcription history
- `lipcoder.openASRTestPage` - Open browser test page
- `lipcoder.testASRServer` - Test ASR server connection

## Usage

### Method 1: Keyboard Shortcut
1. Press `Ctrl+Shift+A` (or `Cmd+Shift+A` on Mac)
2. Follow the instructions to open the browser test page
3. Grant microphone permissions in the browser
4. Speak to see transcriptions in VS Code

### Method 2: Command Palette
1. Press `Ctrl+Shift+P` (or `Cmd+Shift+P` on Mac)
2. Type "Toggle ASR"
3. Select the command
4. Follow the browser instructions

### Method 3: Status Bar
1. Look at the status bar (bottom right)
2. Click the microphone icon with "ASR OFF/ON"
3. Follow the browser instructions

### Method 4: Direct Browser Access
1. Open `http://localhost:8080/test_asr.html`
2. Click "Start ASR Streaming"
3. Grant microphone permissions
4. Speak and see transcriptions

## Setup Requirements

### 1. ASR Server
```bash
cd server
gunicorn --workers 2 --bind 0.0.0.0:5005 silero_asr_server:app
```

### 2. HTTP Server (for test page)
```bash
cd client
python3 -m http.server 8080
```

### 3. VS Code Extension
- Build the extension: `npm run build`
- Reload VS Code window
- Commands should appear in Command Palette

## Visual Indicators

### Status Bar
```
$(mic) ASR OFF  ← When stopped
$(mic) ASR ON   ← When recording (highlighted)
```

### Notifications
- **Starting**: Instructions to open browser test page
- **Started**: "ASR streaming started (browser-based)"
- **Stopping**: "ASR streaming stopped"
- **Transcriptions**: "ASR: [transcribed text]"
- **Errors**: "ASR Error: [error message]"

## Browser Test Page Features

### Controls
- **Start ASR Streaming**: Begin microphone capture
- **Stop ASR Streaming**: Stop microphone capture
- **Toggle ASR Streaming**: Switch on/off
- **Test Server Connection**: Check ASR server status
- **Check Status**: Show current recording status
- **Clear Output**: Clear transcription history

### Real-time Features
- **Live Transcriptions**: See speech-to-text in real-time
- **Timestamp Display**: Each transcription shows time
- **Error Handling**: Clear error messages
- **Status Updates**: Visual feedback for all actions

## Configuration

### Default Settings
- **Chunk Duration**: 2 seconds per audio chunk
- **Sample Rate**: 16kHz (required by Silero)
- **Server URL**: `http://localhost:5005/asr`
- **Audio Format**: WAV (16-bit, mono)

### Browser Requirements
- **HTTPS or localhost**: Required for microphone access
- **Microphone Permission**: Must be granted by user
- **Modern Browser**: Chrome, Firefox, Safari, Edge

## Troubleshooting

### Common Issues

1. **"navigator is not defined"**
   - This is expected in VS Code extension environment
   - Use browser test page for actual audio capture
   - VS Code provides status tracking and notifications

2. **"Microphone permission denied"**
   - Grant microphone permissions in browser
   - Check system microphone settings
   - Try refreshing the browser page

3. **"ASR server not connected"**
   - Ensure ASR server is running on port 5005
   - Check CORS settings on the server
   - Use "Test ASR Server" command to verify

4. **"Commands not appearing in VS Code"**
   - Reload VS Code window: `Ctrl+Shift+P` → "Developer: Reload Window"
   - Check extension is enabled
   - Verify build was successful

### Debug Commands

```bash
# Test ASR server
curl -X POST http://localhost:5005/asr -F "audio=@test.wav"

# Check server status
curl -X OPTIONS http://localhost:5005/asr

# Start HTTP server for test page
cd client && python3 -m http.server 8080
```

## Architecture

### VS Code Extension
- **Status Tracking**: Manages ASR state
- **Notifications**: Shows transcriptions and errors
- **Output Panel**: Displays transcription history
- **Commands**: Provides user interface

### Browser Test Page
- **Audio Capture**: Handles microphone access
- **Real-time Processing**: Chunks and processes audio
- **Server Communication**: Sends audio to ASR server
- **UI Feedback**: Shows status and transcriptions

### ASR Server
- **Audio Processing**: Converts audio to text
- **Silero Model**: Uses pre-trained speech recognition
- **CORS Support**: Allows browser requests
- **Error Handling**: Provides detailed error messages

## Benefits of This Approach

### Security
- **Browser Sandbox**: Microphone access is isolated
- **User Control**: Explicit permission granting
- **No Native Code**: Avoids security concerns

### Compatibility
- **Cross-platform**: Works on all operating systems
- **Browser Support**: Uses standard web APIs
- **VS Code Integration**: Seamless extension experience

### Development
- **Easy Testing**: Browser provides immediate feedback
- **Debugging**: Browser dev tools for troubleshooting
- **Rapid Iteration**: Quick changes and testing

## Future Enhancements

- [ ] **WebSocket Integration**: Real-time VS Code ↔ Browser communication
- [ ] **Voice Commands**: Use transcriptions to trigger VS Code commands
- [ ] **Multiple Languages**: Support for different ASR models
- [ ] **Confidence Scores**: Show transcription confidence levels
- [ ] **Audio Visualization**: Real-time waveform display
- [ ] **Offline Mode**: Local ASR processing without server 