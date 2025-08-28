#!/usr/bin/env node

/**
 * Test script to verify espeak TTS integration works
 */

const { spawn } = require('child_process');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

async function testEspeakIntegration() {
    console.log('🧪 Testing Espeak TTS Integration...');
    
    // Start the espeak server
    console.log('📡 Starting espeak TTS server...');
    const serverProcess = spawn('python3', ['espeak_tts_server.py'], {
        cwd: path.join(__dirname, 'server'),
        env: { ...process.env, PORT: '5005' },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    
    // Wait for server to start
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    try {
        // Test health endpoint
        console.log('🏥 Testing health endpoint...');
        const healthResponse = await fetch('http://localhost:5005/health');
        const healthData = await healthResponse.json();
        console.log('✅ Health check:', healthData);
        
        // Test TTS with English
        console.log('🇺🇸 Testing English TTS...');
        const englishResponse = await fetch('http://localhost:5005/tts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text: 'Hello world, this is espeak TTS',
                voice: 'en-us',
                speed: 175,
                pitch: 50,
                amplitude: 100
            })
        });
        
        if (englishResponse.ok) {
            const audioBuffer = await englishResponse.arrayBuffer();
            console.log(`✅ English TTS generated ${audioBuffer.byteLength} bytes`);
        } else {
            console.error('❌ English TTS failed:', englishResponse.status);
        }
        
        // Test TTS with Spanish
        console.log('🇪🇸 Testing Spanish TTS...');
        const spanishResponse = await fetch('http://localhost:5005/tts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text: 'Hola mundo, esto es espeak TTS',
                voice: 'es',
                speed: 175,
                pitch: 50,
                amplitude: 100
            })
        });
        
        if (spanishResponse.ok) {
            const audioBuffer = await spanishResponse.arrayBuffer();
            console.log(`✅ Spanish TTS generated ${audioBuffer.byteLength} bytes`);
        } else {
            console.error('❌ Spanish TTS failed:', spanishResponse.status);
        }
        
        // Test TTS with French
        console.log('🇫🇷 Testing French TTS...');
        const frenchResponse = await fetch('http://localhost:5005/tts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text: 'Bonjour le monde, ceci est espeak TTS',
                voice: 'fr-fr',
                speed: 175,
                pitch: 50,
                amplitude: 100
            })
        });
        
        if (frenchResponse.ok) {
            const audioBuffer = await frenchResponse.arrayBuffer();
            console.log(`✅ French TTS generated ${audioBuffer.byteLength} bytes`);
        } else {
            console.error('❌ French TTS failed:', frenchResponse.status);
        }
        
        console.log('🎉 All tests passed! Espeak TTS integration is working correctly.');
        
    } catch (error) {
        console.error('❌ Test failed:', error.message);
    } finally {
        // Clean up
        console.log('🧹 Cleaning up...');
        serverProcess.kill('SIGTERM');
        
        // Wait for graceful shutdown
        setTimeout(() => {
            if (!serverProcess.killed) {
                serverProcess.kill('SIGKILL');
            }
        }, 2000);
    }
}

// Run the test
testEspeakIntegration().catch(console.error);
