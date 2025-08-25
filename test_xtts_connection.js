#!/usr/bin/env node

/**
 * Test XTTS connection from Node.js environment (similar to VS Code extension)
 */

const http = require('http');
const https = require('https');

// Test function using Node.js built-in modules (like VS Code extension)
async function testXTTSConnection() {
    console.log('🧪 Testing XTTS connection from Node.js...');
    
    // Test 1: Health check
    console.log('\n1. Testing health endpoint...');
    try {
        const healthData = await makeRequest('GET', 'http://localhost:5006/health');
        const health = JSON.parse(healthData);
        console.log('✅ Health check successful');
        console.log(`   Status: ${health.status}`);
        console.log(`   Model loaded: ${health.model_loaded}`);
        console.log(`   Cached embeddings: ${health.speaker_cache?.cached_embeddings || 0}`);
    } catch (error) {
        console.log('❌ Health check failed:', error.message);
        return;
    }
    
    // Test 2: TTS Fast endpoint
    console.log('\n2. Testing TTS fast endpoint...');
    try {
        const ttsData = {
            text: "안녕하세요",
            language: "ko",
            category: "comment",
            sample_rate: 24000
        };
        
        const audioData = await makeRequest('POST', 'http://localhost:5006/tts_fast', ttsData);
        console.log('✅ TTS fast endpoint successful');
        console.log(`   Audio data size: ${audioData.length} bytes`);
    } catch (error) {
        console.log('❌ TTS fast endpoint failed:', error.message);
        
        // Test 3: Fallback to regular TTS endpoint
        console.log('\n3. Testing regular TTS endpoint...');
        try {
            const audioData = await makeRequest('POST', 'http://localhost:5006/tts', ttsData);
            console.log('✅ Regular TTS endpoint successful');
            console.log(`   Audio data size: ${audioData.length} bytes`);
        } catch (error2) {
            console.log('❌ Regular TTS endpoint also failed:', error2.message);
        }
    }
    
    // Test 4: Cache stats
    console.log('\n4. Testing cache stats...');
    try {
        const cacheData = await makeRequest('GET', 'http://localhost:5006/cache/stats');
        const cache = JSON.parse(cacheData);
        console.log('✅ Cache stats successful');
        console.log(`   Cached embeddings: ${cache.cached_embeddings}`);
        console.log(`   Voice stats:`, Object.keys(cache.voice_stats || {}));
    } catch (error) {
        console.log('❌ Cache stats failed:', error.message);
    }
}

// Helper function to make HTTP requests
function makeRequest(method, url, data = null) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const isHttps = urlObj.protocol === 'https:';
        const httpModule = isHttps ? https : http;
        
        const options = {
            hostname: urlObj.hostname,
            port: urlObj.port,
            path: urlObj.pathname + urlObj.search,
            method: method,
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'lipcoder-test/1.0'
            }
        };
        
        if (data && method === 'POST') {
            const postData = JSON.stringify(data);
            options.headers['Content-Length'] = Buffer.byteLength(postData);
        }
        
        const req = httpModule.request(options, (res) => {
            let responseData = Buffer.alloc(0);
            
            res.on('data', (chunk) => {
                responseData = Buffer.concat([responseData, chunk]);
            });
            
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    // For JSON responses, return as string
                    if (res.headers['content-type']?.includes('application/json')) {
                        resolve(responseData.toString());
                    } else {
                        // For binary data (audio), return buffer
                        resolve(responseData);
                    }
                } else {
                    reject(new Error(`HTTP ${res.statusCode}: ${responseData.toString()}`));
                }
            });
        });
        
        req.on('error', (error) => {
            reject(new Error(`Request failed: ${error.message}`));
        });
        
        req.setTimeout(10000, () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });
        
        if (data && method === 'POST') {
            req.write(JSON.stringify(data));
        }
        
        req.end();
    });
}

// Run the test
testXTTSConnection().catch(console.error);
