# Command Mismatch Fix: `lipcoder.toggleASRStreaming`

## 🚨 **Problem Identified**

The user encountered this error:
```
Command 'LipCoder: Toggle ASR Streaming' resulted in an error command 'lipcoder.toggleASRStreaming' not found
```

## 🔍 **Root Cause Analysis**

The issue was a **command mismatch** between `package.json` and the actual code registration:

### **Package.json Defined:**
```json
{
  "command": "lipcoder.toggleASRStreaming",
  "title": "Toggle ASR Streaming",
  "category": "LipCoder"
}
```

### **Code Only Registered:**
```typescript
// Only registered 'lipcoder.toggleASR'
vscode.commands.registerCommand('lipcoder.toggleASR', async () => {
    // ... implementation
});
```

### **Missing Registration:**
```typescript
// This command was missing!
vscode.commands.registerCommand('lipcoder.toggleASRStreaming', async () => {
    // ... implementation
});
```

## ✅ **Solution Implemented**

### **1. Added Missing Command Registration**
```typescript
// Register toggle ASR streaming command
const toggleASRStreamingCommand = vscode.commands.registerCommand('lipcoder.toggleASRStreaming', async () => {
    try {
        log('[Toggle ASR] Toggle ASR Streaming command executed');
        
        if (!asrClient || !asrClient.getRecordingStatus()) {
            // Start ASR streaming
            log('[Toggle ASR] Starting ASR streaming via toggle streaming command...');
            
            asrClient = new ASRClient({
                chunkDuration: 2000,
                sampleRate: 16000,
                serverUrl: 'http://localhost:5005/asr',
                onTranscription: (chunk) => {
                    log(`[Toggle ASR] Toggle Streaming Transcription received: "${chunk.text}"`);
                    vscode.window.showInformationMessage(`ASR: ${chunk.text}`);
                    if (outputChannel) {
                        outputChannel.appendLine(`[${new Date().toISOString()}] ${chunk.text}`);
                    }
                },
                onError: (error) => {
                    log(`[Toggle ASR] Toggle Streaming ASR error: ${error.message}`);
                    vscode.window.showErrorMessage(`ASR Error: ${error.message}`);
                }
            });
            
            await asrClient.startStreaming();
            log('[Toggle ASR] ASR streaming started via toggle streaming command');
            
            if (statusBarItem) {
                statusBarItem.text = '$(mic) ASR ON';
                statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
            }
            
        } else {
            // Stop ASR streaming
            log('[Toggle ASR] Stopping ASR streaming via toggle streaming command...');
            
            asrClient.stopStreaming();
            asrClient = null;
            log('[Toggle ASR] ASR streaming stopped via toggle streaming command');
            
            if (statusBarItem) {
                statusBarItem.text = '$(mic) ASR';
                statusBarItem.backgroundColor = undefined;
            }
        }
        
    } catch (error) {
        log(`[Toggle ASR] Error in toggle ASR streaming command: ${error}`);
        vscode.window.showErrorMessage(`Toggle ASR Streaming Error: ${error}`);
    }
});
```

### **2. Added to Context Subscriptions**
```typescript
// Add commands to context
context.subscriptions.push(
    toggleCommand,
    toggleASRStreamingCommand,  // ← Added this line
    showOutputCommand,
    clearOutputCommand,
    getStatusCommand,
    openTestPageCommand,
    testServerCommand,
    startASRCommand,
    stopASRCommand,
    testTranscriptionCommand,
    simulateAudioCommand
);
```

## 🎯 **Available Commands Now**

### **Both Commands Work:**
- ✅ **`lipcoder.toggleASR`**: "Toggle ASR" (keyboard shortcut: `Ctrl+Shift+A`)
- ✅ **`lipcoder.toggleASRStreaming`**: "Toggle ASR Streaming" (command palette)

### **Other ASR Commands:**
- ✅ **`lipcoder.startASRStreaming`**: "Start ASR Streaming"
- ✅ **`lipcoder.stopASRStreaming`**: "Stop ASR Streaming"
- ✅ **`lipcoder.showASROutput`**: "Show ASR Output"
- ✅ **`lipcoder.clearASROutput`**: "Clear ASR Output"
- ✅ **`lipcoder.getASRStatus`**: "Get ASR Status"
- ✅ **`lipcoder.openASRTestPage`**: "Open ASR Test Page"
- ✅ **`lipcoder.testASRServer`**: "Test ASR Server"
- ✅ **`lipcoder.testTranscription`**: "Test Transcription"
- ✅ **`lipcoder.simulateAudioProcessing`**: "Simulate Audio Processing"

## 🎉 **How to Use**

### **Method 1: Command Palette**
1. Press `Ctrl+Shift+P`
2. Type "Toggle ASR Streaming"
3. Select the command
4. ASR will start/stop

### **Method 2: Keyboard Shortcut**
1. Press `Ctrl+Shift+A`
2. ASR will toggle on/off

### **Method 3: Status Bar**
1. Click the microphone icon in the status bar
2. ASR will toggle on/off

## 📊 **Expected Behavior**

### **When Starting ASR:**
```
[Toggle ASR] Toggle ASR Streaming command executed
[Toggle ASR] Starting ASR streaming via toggle streaming command...
[ASR] Starting real microphone stream...
[ASR] Microphone initialized
[ASR] Real microphone stream started successfully
[Toggle ASR] ASR streaming started via toggle streaming command
```

### **When Stopping ASR:**
```
[Toggle ASR] Stopping ASR streaming via toggle streaming command...
[ASR] Stopping real microphone stream...
[ASR] Real microphone stream stopped
[Toggle ASR] ASR streaming stopped via toggle streaming command
```

## 🎤 **Real Microphone ASR**

Both commands now use **real microphone capture**:
- ✅ **Real Audio**: Captures actual voice input
- ✅ **Real Processing**: Live audio streaming
- ✅ **Real Transcriptions**: Actual speech-to-text
- ✅ **Real Logging**: All transcriptions logged

**The command mismatch is fixed! Both "Toggle ASR" and "Toggle ASR Streaming" now work with real microphone ASR.** 🎤✨ 