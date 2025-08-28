#!/usr/bin/env node

/**
 * Generate text-based earcon PCM files for spoken special characters
 * This creates PCM files in special_espeak folder with spoken text versions of earcons
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Earcon to spoken text mappings (matching config.ts)
const earconTextMap = {
    // Parentheses & brackets
    '(': 'left parenthesis',
    ')': 'right parenthesis',
    '[': 'left bracket',
    ']': 'right bracket',
    '{': 'left brace',
    '}': 'right brace',
    '<': 'less than',
    '>': 'greater than',

    // Quotes
    '"': 'double quote',
    "'": 'single quote',
    '`': 'backtick',

    // Basic punctuation
    '.': 'dot',
    ',': 'comma',
    ';': 'semicolon',
    ':': 'colon',
    '_': 'underscore',     // changed from underbar
    '-': 'minus',          // better than dash (used in math & code)

    // Operators
    '=': 'equals',
    '+': 'plus',
    '*': 'asterisk',
    '/': 'slash',
    '\\': 'backslash',
    '|': 'vertical bar',   // pipe is slang; vertical bar is canonical
    '&': 'ampersand',

    // Special characters
    '!': 'exclamation mark',
    '@': 'at sign',
    '#': 'hash',
    '$': 'dollar',
    '%': 'percent',
    '^': 'caret',
    '?': 'question mark',
    '~': 'tilde',
    '₩': 'won sign',

    // Multi-character operators
    '++': 'plus plus',                // often read literally
    '--': 'minus minus',
    '+=': 'plus equals',
    '-=': 'minus equals',
    '*=': 'times equals',
    '/=': 'divide equals',
    '==': 'equals equals',
    '!=': 'not equals',
    '===': 'triple equals',
    '!==': 'not triple equals',
    '<=': 'less than or equal',
    '>=': 'greater than or equal',
    '&&': 'logical and',
    '||': 'logical or',
    '//': 'double slash',
    '=>': 'arrow',

    // Whitespace
    ' ': 'space',
    '\t': 'tab',
    '\n': 'newline'
};

// Map special characters to their file names (for consistency with existing system)
const charToFileName = {
    '(': 'parenthesis',
    ')': 'parenthesis2',
    '[': 'squarebracket',
    ']': 'squarebracket2',
    '{': 'brace',
    '}': 'brace2',
    '<': 'anglebracket',
    '>': 'anglebracket2',
    '"': 'bigquote',
    "'": 'quote',
    '`': 'backtick',
    '.': 'dot',
    ',': 'comma',
    ';': 'semicolon',
    ':': 'colon',
    '_': 'underbar',
    '-': 'dash',
    '=': 'equals',
    '+': 'plus',
    '*': 'asterisk',
    '/': 'slash',
    '\\': 'backslash',
    '|': 'bar',
    '&': 'ampersand',
    '!': 'excitation',
    '@': 'at',
    '#': 'sharp',
    '$': 'dollar',
    '%': 'percent',
    '^': 'caret',
    '?': 'question',
    '~': 'tilde',
    '₩': 'won',
    '++': 'plus_plus',
    '--': 'minus_minus',
    '+=': 'plus_equals',
    '-=': 'minus_equals',
    '*=': 'times_equals',
    '/=': 'divide_equals',
    '==': 'equals_equals',
    '!=': 'not_equal',
    '===': 'triple_equals',
    '!==': 'not_triple_equals',
    '<=': 'less_than_or_equal',
    '>=': 'greater_than_or_equal',
    '&&': 'and_and',
    '||': 'or_or',
    '//': 'slash_slash',
    '=>': 'arrow',
    ' ': 'space'
};

// Default espeak settings for text earcons
const defaultEspeakSettings = {
    voice: 'en-us',
    speed: 200,  // Slightly faster for short phrases
    pitch: 50,
    amplitude: 100,
    gap: 0,
    sampleRate: 24000
};

// Check if espeak TTS server is running
async function checkEspeakServer() {
    try {
        const response = await fetch('http://localhost:5005/health');
        return response.ok;
    } catch (error) {
        return false;
    }
}

// Generate TTS using espeak server
async function generateTTS(text, settings = {}) {
    const espeakSettings = { ...defaultEspeakSettings, ...settings };
    
    console.log(`[TTS] Generating: "${text}" with voice ${espeakSettings.voice}`);
    
    const response = await fetch('http://localhost:5005/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            text: text,
            voice: espeakSettings.voice,
            speed: espeakSettings.speed,
            pitch: espeakSettings.pitch,
            amplitude: espeakSettings.amplitude,
            gap: espeakSettings.gap,
            sample_rate: espeakSettings.sampleRate,
        })
    });
    
    if (!response.ok) {
        throw new Error(`TTS server error: ${response.status} ${response.statusText}`);
    }
    
    return Buffer.from(await response.arrayBuffer());
}

// Convert WAV to PCM using ffmpeg
function convertWavToPcm(wavPath, pcmPath) {
    return new Promise((resolve, reject) => {
        const ffmpeg = spawn('ffmpeg', [
            '-y',                    // Overwrite output files
            '-i', wavPath,           // Input WAV file
            '-f', 's16le',           // Output format: signed 16-bit little-endian
            '-ar', '24000',          // Sample rate: 24kHz
            '-ac', '2',              // Channels: stereo
            pcmPath                  // Output PCM file
        ]);

        ffmpeg.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`ffmpeg exited with code ${code}`));
            }
        });

        ffmpeg.on('error', (error) => {
            reject(error);
        });
    });
}

// Main generation function
async function generateTextEarcons() {
    const audioRoot = path.join(__dirname, '..', 'client', 'audio');
    const outputDir = path.join(audioRoot, 'special_espeak_text');
    
    // Create output directory
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
        console.log(`Created directory: ${outputDir}`);
    }
    
    // Check if espeak server is running
    if (!(await checkEspeakServer())) {
        console.error('❌ Espeak TTS server is not running on port 5005');
        console.error('Please start the server first: cd server && ./start_espeak_tts.sh');
        process.exit(1);
    }
    
    console.log('✅ Espeak TTS server is running');
    console.log(`📁 Output directory: ${outputDir}`);
    console.log(`🔊 Generating ${Object.keys(earconTextMap).length} text-based earcons...`);
    
    let generated = 0;
    let skipped = 0;
    
    for (const [char, spokenText] of Object.entries(earconTextMap)) {
        // Skip whitespace characters for now
        if ([' ', '\t', '\n'].includes(char)) {
            continue;
        }
        
        const fileName = charToFileName[char];
        if (!fileName) {
            console.warn(`⚠️  No filename mapping for character: "${char}"`);
            continue;
        }
        
        const wavPath = path.join(outputDir, `${fileName}.wav`);
        const pcmPath = path.join(outputDir, `${fileName}.pcm`);
        
        // Skip if PCM already exists (unless force flag is set)
        if (fs.existsSync(pcmPath) && !process.argv.includes('--force')) {
            console.log(`⏭️  Skipping existing: ${fileName}.pcm`);
            skipped++;
            continue;
        }
        
        try {
            // Generate WAV using TTS
            const audioBuffer = await generateTTS(spokenText);
            fs.writeFileSync(wavPath, audioBuffer);
            
            // Convert to PCM
            await convertWavToPcm(wavPath, pcmPath);
            
            // Clean up WAV file (keep only PCM)
            fs.unlinkSync(wavPath);
            
            console.log(`✅ Generated: ${fileName}.pcm ("${char}" → "${spokenText}")`);
            generated++;
            
        } catch (error) {
            console.error(`❌ Failed to generate ${fileName}: ${error.message}`);
        }
    }
    
    console.log(`\n🎉 Text earcon generation complete!`);
    console.log(`   Generated: ${generated} files`);
    console.log(`   Skipped: ${skipped} files`);
    console.log(`   Output: ${outputDir}`);
    
    if (generated > 0) {
        console.log(`\n💡 To use text earcons, set earconMode to EarconMode.Text in your VS Code settings`);
    }
}

// Run the script
if (require.main === module) {
    generateTextEarcons().catch(error => {
        console.error('❌ Script failed:', error.message);
        process.exit(1);
    });
}

module.exports = { generateTextEarcons, earconTextMap };
