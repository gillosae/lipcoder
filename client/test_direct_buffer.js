const FormData = require('form-data');
const fetch = require('node-fetch');

async function testDirectBuffer() {
    try {
        console.log('[TEST] Testing direct buffer sending...');
        
        // Create audio data exactly like the VS Code extension does
        const sampleRate = 16000;
        const duration = 2; // 2 seconds
        const numSamples = sampleRate * duration;
        
        // Create a simple sine wave (440 Hz) as test audio
        const audioData = new Float32Array(numSamples);
        for (let i = 0; i < numSamples; i++) {
            audioData[i] = Math.sin(2 * Math.PI * 440 * i / sampleRate) * 0.1;
        }
        
        // Convert to WAV format (exactly like the VS Code extension)
        const int16Data = new Int16Array(audioData.length);
        for (let i = 0; i < audioData.length; i++) {
            const sample = Math.max(-1, Math.min(1, audioData[i]));
            int16Data[i] = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
        }

        // Create WAV header (exactly like the VS Code extension)
        const buffer = Buffer.alloc(44 + int16Data.length * 2);
        
        // WAV header
        buffer.write('RIFF', 0);
        buffer.writeUInt32LE(36 + int16Data.length * 2, 4);
        buffer.write('WAVE', 8);
        buffer.write('fmt ', 12);
        buffer.writeUInt32LE(16, 16);
        buffer.writeUInt16LE(1, 20);
        buffer.writeUInt16LE(1, 22); // mono
        buffer.writeUInt32LE(sampleRate, 24);
        buffer.writeUInt32LE(sampleRate * 2, 28); // bytes per second
        buffer.writeUInt16LE(2, 32); // bytes per sample
        buffer.writeUInt16LE(16, 34); // bits per sample
        buffer.write('data', 36);
        buffer.writeUInt32LE(int16Data.length * 2, 40);

        // Copy audio data
        const audioBuffer = Buffer.from(int16Data.buffer);
        audioBuffer.copy(buffer, 44);
        
        console.log(`[TEST] Created WAV file: ${buffer.length} bytes`);
        
        // Create form data (sending buffer directly like VS Code extension now does)
        const formData = new FormData();
        
        // Append buffer directly (like VS Code extension now does)
        formData.append('audio', buffer, {
            filename: 'chunk.wav',
            contentType: 'audio/wav'
        });
        
        console.log('[TEST] Created form data with direct buffer');
        console.log(`[TEST] Form data headers: ${JSON.stringify(formData.getHeaders())}`);
        
        // Send to server
        const response = await fetch('http://localhost:5005/asr', {
            method: 'POST',
            body: formData
        });
        
        console.log(`[TEST] Server response: ${response.status} ${response.statusText}`);
        
        if (!response.ok) {
            const errorText = await response.text();
            console.log(`[TEST] Error response: ${errorText}`);
        } else {
            const result = await response.json();
            console.log(`[TEST] Success response: ${JSON.stringify(result)}`);
        }
        
    } catch (error) {
        console.error('[TEST] Error:', error);
    }
}

testDirectBuffer(); 