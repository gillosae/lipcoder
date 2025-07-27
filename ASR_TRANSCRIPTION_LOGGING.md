# LipCoder ASR Transcription Logging Guide

This document explains how to see ASR transcription output in the logs and how to test transcription logging.

## 🎯 **Why Transcription Logs Were Missing**

The original implementation had logging for transcription, but it wasn't visible because:

1. **VS Code Extension**: Uses simulated audio capture (no real microphone)
2. **Browser Test Page**: Has its own `processAudioChunk` method
3. **Callback Chain**: Transcription logs were in the callback but not highlighted

## ✅ **Enhanced Transcription Logging**

### **1. ASR Client Logging**
```typescript
// In processAudioChunk method
if (transcription) {
    log(`[ASR] Transcription received: "${transcription}"`);
    if (this.options.onTranscription) {
        const asrChunk: ASRChunk = {
            text: transcription,
            timestamp: Date.now()
        };
        log(`[ASR] Calling transcription callback with: "${transcription}"`);
        this.options.onTranscription(asrChunk);
        log(`[ASR] Transcription callback completed`);
    } else {
        log(`[ASR] No transcription callback registered, transcription: "${transcription}"`);
    }
} else {
    log('[ASR] No transcription received from server');
}
```

### **2. Toggle ASR Feature Logging**
```typescript
onTranscription: (chunk: ASRChunk) => {
    const timestamp = new Date(chunk.timestamp).toLocaleTimeString();
    const message = `[${timestamp}] ${chunk.text}`;
    
    log(`[ASR] Toggle ASR Transcription received: "${chunk.text}"`);
    log(`[ASR] Toggle ASR Transcription timestamp: ${timestamp}`);
    outputChannel?.appendLine(message);
    
    vscode.window.showInformationMessage(`ASR: ${chunk.text}`);
    log(`[ASR] Toggle ASR Transcription notification shown: "${chunk.text}"`);
}
```

### **3. Push-to-Talk Feature Logging**
```typescript
onTranscription: (chunk: ASRChunk) => {
    const timestamp = new Date(chunk.timestamp).toLocaleTimeString();
    const message = `[${timestamp}] ${chunk.text}`;
    
    log(`[ASR] Push-to-Talk Transcription received: "${chunk.text}"`);
    log(`[ASR] Push-to-Talk Transcription timestamp: ${timestamp}`);
    outputChannel?.appendLine(message);
    
    vscode.window.showInformationMessage(`ASR: ${chunk.text}`);
    log(`[ASR] Push-to-Talk Transcription notification shown: "${chunk.text}"`);
}
```

### **4. Browser Test Page Logging**
```javascript
if (transcription && this.options.onTranscription) {
    const asrChunk = {
        text: transcription,
        timestamp: Date.now()
    };
    console.log(`[ASR] Browser Transcription received: "${transcription}"`);
    console.log(`[ASR] Browser Transcription timestamp: ${new Date(asrChunk.timestamp).toLocaleTimeString()}`);
    this.options.onTranscription(asrChunk);
    console.log(`[ASR] Browser Transcription callback completed`);
} else if (transcription) {
    console.log(`[ASR] Browser Transcription received but no callback: "${transcription}"`);
} else {
    console.log('[ASR] Browser No transcription received from server');
}
```

## 🧪 **Testing Transcription Logging**

### **New Test Command**
Added `lipcoder.testTranscription` command to test transcription logging:

1. **Command Palette**: `Ctrl+Shift+P` → "Test Transcription"
2. **Simulates**: A test transcription without needing real audio
3. **Shows**: Complete logging chain for transcription

### **Test Command Implementation**
```typescript
vscode.commands.registerCommand('lipcoder.testTranscription', () => {
    log('[ASR] Test transcription command executed');
    try {
        if (asrClient) {
            const testText = 'This is a test transcription from the ASR system';
            log(`[ASR] Simulating transcription: "${testText}"`);
            asrClient.simulateTranscription(testText);
            vscode.window.showInformationMessage('Test transcription sent to output');
        } else {
            // Create temporary client for testing
            const testClient = new ASRClient({
                onTranscription: (chunk: ASRChunk) => {
                    const timestamp = new Date(chunk.timestamp).toLocaleTimeString();
                    const message = `[${timestamp}] ${chunk.text}`;
                    
                    log(`[ASR] Test Transcription received: "${chunk.text}"`);
                    log(`[ASR] Test Transcription timestamp: ${timestamp}`);
                    outputChannel?.appendLine(message);
                    
                    vscode.window.showInformationMessage(`Test ASR: ${chunk.text}`);
                    log(`[ASR] Test Transcription notification shown: "${chunk.text}"`);
                }
            });
            
            const testText = 'This is a test transcription from the ASR system';
            log(`[ASR] Simulating test transcription: "${testText}"`);
            testClient.simulateTranscription(testText);
            vscode.window.showInformationMessage('Test transcription completed');
        }
    } catch (error) {
        vscode.window.showErrorMessage(`Test transcription failed: ${error}`);
        log(`[ASR] Test transcription failed: ${error}`);
    }
});
```

### **Simulate Transcription Method**
```typescript
simulateTranscription(text: string): void {
    log(`[ASR] Simulating transcription: "${text}"`);
    if (this.options.onTranscription) {
        const asrChunk: ASRChunk = {
            text: text,
            timestamp: Date.now()
        };
        log(`[ASR] Calling transcription callback with simulated text: "${text}"`);
        this.options.onTranscription(asrChunk);
        log(`[ASR] Simulated transcription callback completed`);
    } else {
        log(`[ASR] No transcription callback registered for simulated text: "${text}"`);
    }
}
```

## 📍 **Where to See Transcription Logs**

### **VS Code Extension**
1. **Output Panel**: View → Output → LipCoder ASR
2. **Developer Console**: Help → Toggle Developer Tools → Console
3. **Notifications**: VS Code notifications for each transcription

### **Browser Test Page**
1. **Browser Console**: F12 → Console tab
2. **Filter Logs**: Look for `[ASR] Browser Transcription` messages
3. **Real-time**: See transcriptions as you speak

### **Server Logs**
```bash
# Monitor ASR server responses
tail -f server.log | grep "text"

# Test with curl
curl -X POST http://localhost:5005/asr -F "audio=@test.wav" -v
```

## 🔍 **Expected Log Output**

### **When Transcription Works**
```
[ASR] Sending 4140 bytes to ASR server: http://localhost:5005/asr
[ASR] Server response received in 250ms: status=200, statusText=OK
[ASR] Server response parsed: {"text":"hello this is a test"}
[ASR] Transcription received: "hello this is a test"
[ASR] Calling transcription callback with: "hello this is a test"
[ASR] Toggle ASR Transcription received: "hello this is a test"
[ASR] Toggle ASR Transcription timestamp: 10:30:45 AM
[ASR] Toggle ASR Transcription notification shown: "hello this is a test"
[ASR] Transcription callback completed
```

### **When No Transcription**
```
[ASR] Sending 4140 bytes to ASR server: http://localhost:5005/asr
[ASR] Server response received in 250ms: status=200, statusText=OK
[ASR] Server response parsed: {"text":""}
[ASR] No transcription received from server
```

### **When Server Error**
```
[ASR] Sending 4140 bytes to ASR server: http://localhost:5005/asr
[ASR] Server response received in 250ms: status=500, statusText=Internal Server Error
[ASR] Server error response: {"error":"Invalid audio format"}
[ASR] Error sending to server: ASR server error: 500 Internal Server Error
```

## 🎯 **How to Test**

### **1. Test Command (Recommended)**
```bash
# In VS Code Command Palette
Ctrl+Shift+P → "Test Transcription"
```

### **2. Browser Test Page**
```bash
# Start HTTP server
cd client && python3 -m http.server 8080

# Open browser
http://localhost:8080/test_asr.html

# Click "Start ASR Streaming" and speak
```

### **3. Direct Server Test**
```bash
# Test with audio file
curl -X POST http://localhost:5005/asr -F "audio=@test.wav"

# Expected response
{"text":"hello this is a test"}
```

## 🚨 **Troubleshooting**

### **No Transcription Logs**
1. **Check ASR Server**: Ensure server is running on port 5005
2. **Check Audio**: Verify audio file format (WAV, 16kHz, mono)
3. **Check Network**: Ensure CORS is enabled on server
4. **Check Callbacks**: Verify transcription callback is registered

### **Empty Transcription**
1. **Audio Quality**: Check microphone permissions and audio levels
2. **Server Model**: Verify Silero model is loaded correctly
3. **Audio Format**: Ensure correct sample rate and format
4. **Silence**: Try speaking louder or longer

### **Error Messages**
1. **Server Errors**: Check server logs for detailed error messages
2. **Network Errors**: Verify server URL and connectivity
3. **Audio Errors**: Check audio format and file size
4. **CORS Errors**: Ensure CORS is enabled on ASR server

## 📊 **Log Analysis**

### **Performance Metrics**
- **Processing Time**: Time to convert audio to WAV
- **Server Response Time**: Time for ASR server to respond
- **Transcription Quality**: Length and accuracy of transcriptions
- **Error Rate**: Percentage of failed requests

### **Debugging Tips**
1. **Enable Verbose Logging**: Look for detailed `[ASR]` messages
2. **Check Timestamps**: Verify timing of operations
3. **Monitor Callbacks**: Ensure transcription callbacks are called
4. **Test Incrementally**: Test server, then client, then integration

## 🎉 **Summary**

Now you can see detailed transcription logs including:
- ✅ **Transcription Text**: Exact text received from ASR server
- ✅ **Timestamps**: When each transcription was received
- ✅ **Callback Execution**: When transcription callbacks are called
- ✅ **Error Context**: Detailed error information
- ✅ **Performance Metrics**: Timing and statistics
- ✅ **Test Commands**: Easy way to test transcription logging

The enhanced logging provides complete visibility into the ASR transcription process! 🎤 