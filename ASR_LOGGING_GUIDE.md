# LipCoder ASR Streaming Logging Guide

This document describes the comprehensive logging system implemented for the ASR (Automatic Speech Recognition) streaming functionality.

## Overview

The ASR logging system provides detailed insights into:
- **Client Initialization**: Configuration and setup
- **Streaming Lifecycle**: Start, stop, and session management
- **Audio Processing**: Chunk processing and WAV conversion
- **Server Communication**: Request/response details
- **Error Handling**: Detailed error tracking
- **Performance Metrics**: Timing and statistics

## Log Categories

### 🔧 **Initialization Logs**
```
[ASR] Client initialized with options: chunkDuration=2000, sampleRate=16000, serverUrl=http://localhost:5005/asr
[ASR] Registering toggle ASR commands
[ASR] Created output channel: LipCoder ASR
[ASR] Created status bar item for toggle ASR
[ASR] Toggle ASR commands registered successfully
```

### 🎤 **Streaming Lifecycle Logs**
```
[ASR] Starting microphone stream...
[ASR] Stream configuration: chunkDuration=2000, sampleRate=16000, serverUrl=http://localhost:5005/asr
[ASR] Microphone stream started successfully (simulated)
[ASR] Recording session started at: 2024-01-15T10:30:00.000Z
[ASR] Stopping microphone stream...
[ASR] Recording session statistics: sessionDuration=5000ms, chunksProcessed=2, averageChunkTime=2500.00ms, totalAudioProcessed=8192 bytes
[ASR] Microphone stream stopped
```

### 📊 **Audio Processing Logs**
```
[ASR] Processing audio chunk: 4096 bytes
[ASR] Converting audio to WAV format...
[ASR] WAV conversion parameters: sampleRate=16000, numChannels=1, bitsPerSample=16, inputSize=4096
[ASR] WAV conversion complete: 4140 bytes output
[ASR] Audio chunk processed in 150ms
```

### 🌐 **Server Communication Logs**
```
[ASR] Sending 4140 bytes to ASR server: http://localhost:5005/asr
[ASR] Server response received in 250ms: status=200, statusText=OK
[ASR] Server response parsed: {"text":"hello this is a test"}
[ASR] Transcription received: "hello this is a test"
```

### ⚠️ **Error Handling Logs**
```
[ASR] Error starting microphone stream: navigator is not defined
[ASR] Server connection test failed: fetch failed
[ASR] Error sending to server: ASR server error: 500 Internal Server Error
[ASR] Server error response: {"error":"Invalid audio format"}
```

### 🎯 **Command Execution Logs**
```
[ASR] Toggle ASR command executed
[ASR] Starting ASR streaming via toggle...
[ASR] Toggle ASR Transcription received: hello world
[ASR] Stopping ASR streaming via toggle
[ASR] Streaming stopped via toggle
```

### 📈 **Performance Metrics**
```
[ASR] Recording session statistics: sessionDuration=30000ms, chunksProcessed=15, averageChunkTime=2000.00ms, totalAudioProcessed=61440 bytes
[ASR] Audio chunk processed in 150ms
[ASR] Server response received in 250ms: status=200, statusText=OK
```

## Log Levels and Context

### **Info Level** (Default)
- Client initialization
- Command execution
- Status updates
- Successful operations

### **Warning Level**
- Deprecated features
- Performance issues
- Auto-stop events

### **Error Level**
- Failed operations
- Server errors
- Network issues
- Invalid configurations

## Log Format

### **Standard Format**
```
[ASR] Category: Message with details
```

### **Timing Information**
```
[ASR] Operation completed in XXXms
```

### **Statistics Format**
```
[ASR] Statistics: key1=value1, key2=value2, key3=value3
```

## Debugging with Logs

### **1. Client Initialization Issues**
```bash
# Look for these logs:
[ASR] Client initialized with options: ...
[ASR] Registering toggle ASR commands
[ASR] Toggle ASR commands registered successfully
```

### **2. Streaming Problems**
```bash
# Check for:
[ASR] Starting microphone stream...
[ASR] Microphone stream started successfully
[ASR] Error starting microphone stream: ...
```

### **3. Server Communication Issues**
```bash
# Monitor:
[ASR] Sending XXX bytes to ASR server: ...
[ASR] Server response received in XXXms: ...
[ASR] Error sending to server: ...
```

### **4. Performance Analysis**
```bash
# Analyze:
[ASR] Audio chunk processed in XXXms
[ASR] Server response received in XXXms
[ASR] Recording session statistics: ...
```

## Log Locations

### **VS Code Extension Logs**
- **Output Panel**: View → Output → LipCoder ASR
- **Developer Console**: Help → Toggle Developer Tools → Console
- **Extension Host**: Check for `[ASR]` prefixed messages

### **Browser Test Page Logs**
- **Browser Console**: F12 → Console tab
- **Network Tab**: Monitor ASR server requests
- **Performance Tab**: Analyze audio processing

### **Server Logs**
```bash
# ASR Server logs (in terminal running gunicorn)
[INFO] Processing ASR request
[ERROR] Invalid audio format
[SUCCESS] Transcription: "hello world"
```

## Log Analysis Tools

### **VS Code Extension**
```typescript
// Access logs programmatically
import { log } from './utils';

// Custom logging
log('[ASR] Custom message with data');
```

### **Browser Console**
```javascript
// Filter ASR logs
console.log = function(...args) {
    if (args[0] && args[0].includes('[ASR]')) {
        console.log(...args);
    }
};
```

### **Server Monitoring**
```bash
# Monitor ASR server logs
tail -f server.log | grep "ASR"

# Check server performance
curl -X POST http://localhost:5005/asr -F "audio=@test.wav" -w "@curl-format.txt"
```

## Performance Monitoring

### **Key Metrics to Track**
1. **Audio Processing Time**: Time to convert audio to WAV
2. **Server Response Time**: Time for ASR server to respond
3. **Chunk Processing Rate**: Number of chunks processed per second
4. **Error Rate**: Percentage of failed requests
5. **Memory Usage**: Audio buffer sizes and cleanup

### **Performance Logs**
```
[ASR] Audio chunk processed in 150ms
[ASR] Server response received in 250ms
[ASR] Recording session statistics: sessionDuration=30000ms, chunksProcessed=15, averageChunkTime=2000.00ms
```

## Troubleshooting with Logs

### **Common Issues and Log Patterns**

#### **1. "navigator is not defined"**
```
[ASR] Error starting microphone stream: navigator is not defined
```
**Solution**: Use browser test page for actual audio capture

#### **2. Server Connection Issues**
```
[ASR] Server connection test failed: fetch failed
[ASR] Error sending to server: ASR server error: 500 Internal Server Error
```
**Solution**: Check ASR server is running on port 5005

#### **3. Audio Processing Errors**
```
[ASR] Error processing audio chunk: Invalid audio format
[ASR] WAV conversion failed: Buffer size mismatch
```
**Solution**: Verify audio format and sample rate

#### **4. Performance Issues**
```
[ASR] Audio chunk processed in 5000ms  # Too slow
[ASR] Server response received in 10000ms  # Too slow
```
**Solution**: Check network latency and server performance

## Log Configuration

### **Enable Debug Logging**
```typescript
// In VS Code extension
log('[ASR] Debug mode enabled');

// In browser console
localStorage.setItem('asr_debug', 'true');
```

### **Custom Log Levels**
```typescript
// Add to utils.ts
export function logASR(level: 'info' | 'warn' | 'error', message: string) {
    const timestamp = new Date().toISOString();
    log(`[ASR][${level.toUpperCase()}] ${timestamp}: ${message}`);
}
```

## Best Practices

### **1. Log Structure**
- Use consistent `[ASR]` prefix
- Include relevant data in log messages
- Use descriptive error messages

### **2. Performance Logging**
- Log timing for critical operations
- Track resource usage
- Monitor error rates

### **3. Debug Information**
- Include configuration details
- Log state transitions
- Track user interactions

### **4. Error Handling**
- Log full error context
- Include stack traces when relevant
- Provide actionable error messages

## Future Enhancements

- [ ] **Structured Logging**: JSON format for better parsing
- [ ] **Log Levels**: Configurable debug/info/warn/error levels
- [ ] **Log Persistence**: Save logs to file for analysis
- [ ] **Performance Dashboard**: Real-time metrics display
- [ ] **Alert System**: Notify on critical errors
- [ ] **Log Analytics**: Automated log analysis and reporting 