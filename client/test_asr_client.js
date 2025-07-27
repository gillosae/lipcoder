const FormData = require('form-data');
const fs = require('fs');
const fetch = require('node-fetch');

async function testASRClient() {
    try {
        console.log('[TEST] Starting ASR client test...');
        
        // Read the test audio file
        const audioBuffer = fs.readFileSync('/Users/gillosae/Desktop/lipcoder/client/src/python/hello_v3.wav');
        console.log(`[TEST] Read audio file: ${audioBuffer.length} bytes`);
        
        // Create form data
        const formData = new FormData();
        
        // Create a readable stream from the buffer
        const { Readable } = require('stream');
        const stream = new Readable();
        stream.push(audioBuffer);
        stream.push(null); // End the stream
        
        // Append the stream as a file
        formData.append('audio', stream, {
            filename: 'chunk.wav',
            contentType: 'audio/wav'
        });
        
        console.log('[TEST] Created form data with audio stream');
        
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

testASRClient(); 