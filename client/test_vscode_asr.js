const { ASRClient } = require('../dist/client/asr');

async function testVSCodeASR() {
    try {
        console.log('[TEST] Starting VSCode ASR test...');
        
        // Create ASR client like in VS Code extension
        const asrClient = new ASRClient({
            chunkDuration: 2000,
            sampleRate: 16000,
            serverUrl: 'http://localhost:5005/asr',
            onTranscription: (chunk) => {
                console.log(`[TEST] Transcription received: "${chunk.text}"`);
            },
            onError: (error) => {
                console.log(`[TEST] Error: ${error.message}`);
            }
        });
        
        console.log('[TEST] Created ASR client');
        
        // Start streaming (simulated)
        await asrClient.startStreaming();
        console.log('[TEST] Started streaming');
        
        // Simulate audio processing
        await asrClient.simulateAudioProcessing("This is a test transcription from the VS Code extension");
        console.log('[TEST] Simulated audio processing completed');
        
        // Stop streaming
        asrClient.stopStreaming();
        console.log('[TEST] Stopped streaming');
        
    } catch (error) {
        console.error('[TEST] Error:', error);
    }
}

testVSCodeASR(); 