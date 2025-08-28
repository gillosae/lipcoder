import * as fs from 'fs';
import * as path from 'path';
import Speaker from 'speaker';
import { spawn, ChildProcess } from 'child_process';
import { getTokenSound } from './tokens';
import { log, logWarning, logMemory } from './utils';
import { config, EarconMode, earconTextMap, earconModeState } from './config';
import { isEarcon, getSpecialCharSpoken } from './mapping';
import * as os from 'os';

// Standard PCM format for earcon playback  
// NOTE: earcon/*.pcm files are now converted to stereo 24kHz format
const STANDARD_PCM_FORMAT = {
    channels: 2,        // stereo (converted format)
    sampleRate: 24000,   // 24kHz 
    bitDepth: 16,       // 16-bit
    signed: true,
    float: false
};

// File storage for loaded earcon PCM data (lazy-loaded once per earcon)
let earconRaw: Record<string, Buffer> = {};
let earconAccessTimes: Record<string, number> = {};
const MAX_EARCON_CACHE_SIZE_MB = 10; // Limit earcon cache to 10MB

// Export earconRaw for compatibility with audio.ts
export { earconRaw };

/**
 * Clean up old earcon cache entries when memory limit is reached
 */
function cleanupEarconCache(): void {
    const currentSize = Object.values(earconRaw).reduce((total, buf) => total + buf.length, 0);
    const currentSizeMB = currentSize / (1024 * 1024);
    
    if (currentSizeMB > MAX_EARCON_CACHE_SIZE_MB) {
        logWarning(`[Earcon] Cache size limit reached (${currentSizeMB.toFixed(2)}MB), cleaning up old entries`);
        
        // Sort by access time and remove oldest entries
        const entries = Object.entries(earconAccessTimes).sort(([,a], [,b]) => a - b);
        const entriesToRemove = Math.ceil(entries.length / 3); // Remove oldest 33%
        
        for (let i = 0; i < entriesToRemove && i < entries.length; i++) {
            const [key] = entries[i];
            if (earconRaw[key]) {
                delete earconRaw[key];
                delete earconAccessTimes[key];
            }
        }
        
        const newSize = Object.values(earconRaw).reduce((total, buf) => total + buf.length, 0);
        logMemory(`[Earcon] Cleaned up ${entriesToRemove} entries, size: ${(currentSizeMB).toFixed(2)}MB → ${(newSize / 1024 / 1024).toFixed(2)}MB`);
    }
}

let currentSpeaker: Speaker | null = null;
let currentFallback: ChildProcess | null = null;

function hookChildErrors(cp: ChildProcess) {
    cp.on('error', err => {
        log(`🔊 player "error" event: ${err.stack || err}`);
    });
    if (cp.stderr) {
        cp.stderr.on('data', chunk => {
            log(`🔊 player stderr: ${chunk.toString().trim()}`);
        });
    }
    return cp;
}

/**
 * Find the appropriate sound file for a given token
 */
export function findTokenSound(token: string): string | null {
    const primary = getTokenSound(token);
    if (primary) return primary;

    const lower = token.toLowerCase();
    // Alphabet folder (letters)
    const alphaPath = path.join(config.alphabetPath(), `${lower}.pcm`);
    if (fs.existsSync(alphaPath)) return alphaPath;

    // Number folder (digits)
    const numPath = path.join(config.numberPath(), `${lower}.pcm`);
    if (fs.existsSync(numPath)) return numPath;

    // Special‐tokens folder: map single-char token to its spoken name
    const specialName = getSpecialCharSpoken(token);
    if (specialName) {
        // First check backend-specific special folder
        const specPcm = path.join(config.specialPath(), `${specialName}.pcm`);
        const specWav = path.join(config.specialPath(), `${specialName}.wav`);
        console.log(`[findTokenSound] Checking for "${token}" -> "${specialName}": specialPath=${config.specialPath()}, specPcm=${specPcm}, exists=${fs.existsSync(specPcm)}`);
        if (fs.existsSync(specPcm)) {
            console.log(`[findTokenSound] Using backend-specific PCM: ${specPcm}`);
            return specPcm;
        }
        if (fs.existsSync(specWav)) {
            console.log(`[findTokenSound] Using backend-specific WAV: ${specWav}`);
            return specWav;
        }
        // Legacy fallback: old 'special' folder without suffix
        const legacyPcm = path.join(config.audioPath(), 'special', `${specialName}.pcm`);
        const legacyWav = path.join(config.audioPath(), 'special', `${specialName}.wav`);
        console.log(`[findTokenSound] Backend-specific not found, checking legacy: legacyPcm=${legacyPcm}, exists=${fs.existsSync(legacyPcm)}`);
        if (fs.existsSync(legacyPcm)) {
            console.log(`[findTokenSound] Using LEGACY PCM: ${legacyPcm}`);
            return legacyPcm;
        }
        if (fs.existsSync(legacyWav)) {
            console.log(`[findTokenSound] Using LEGACY WAV: ${legacyWav}`);
            return legacyWav;
        }
        // Then fall back to the static earcon folder
        const fallbackEarconPcm = path.join(config.earconPath(), `${specialName}.pcm`);
        const fallbackEarconWav = path.join(config.earconPath(), `${specialName}.wav`);
        if (fs.existsSync(fallbackEarconPcm)) return fallbackEarconPcm;
        if (fs.existsSync(fallbackEarconWav)) return fallbackEarconWav;
    }

    // Check alert folder for special alert sounds (copy, paste, etc.)
    const alertFile = path.join(config.alertPath(), `${token}.pcm`);
    if (fs.existsSync(alertFile)) return alertFile;

    return null;
}

/**
 * Simple panning function for earcons (to avoid circular dependencies)
 */
function applyEarconPanning(pcm: Buffer, format: any, pan: number): Buffer {
    if (format.channels !== 2 || pan === 0) {
        return pcm;
    }
    
    pan = Math.max(-1, Math.min(1, pan));
    const leftGain = pan <= 0 ? 1 : 1 - pan;
    const rightGain = pan <= 0 ? 1 + pan : 1;
    
    const pannedPcm = Buffer.alloc(pcm.length);
    const bytesPerSample = format.bitDepth / 8;
    
    for (let i = 0; i < pcm.length; i += bytesPerSample * 2) {
        if (format.bitDepth === 16) {
            const leftSample = Math.round(pcm.readInt16LE(i) * leftGain);
            const rightSample = Math.round(pcm.readInt16LE(i + 2) * rightGain);
            pannedPcm.writeInt16LE(leftSample, i);
            pannedPcm.writeInt16LE(rightSample, i + 2);
        } else {
            // For other bit depths, just copy
            pcm.copy(pannedPcm, i, i, i + bytesPerSample * 2);
        }
    }
    
    return pannedPcm;
}

/**
 * Play a text-based earcon using TTS or pre-generated text PCM files
 */
async function playTextEarcon(token: string, pan?: number): Promise<void> {
    const spokenText = earconTextMap[token];
    if (!spokenText) {
        log(`[playTextEarcon] No text mapping for token: "${token}"`);
        return Promise.resolve();
    }
    
    // Try to find pre-generated text earcon PCM file first
    const textEarconFile = findTextEarconSound(token);
    if (textEarconFile && fs.existsSync(textEarconFile)) {
        log(`[playTextEarcon] Using pre-generated text earcon: ${textEarconFile}`);
        const { playWave } = require('./audio');
        return playWave(textEarconFile, { isEarcon: true, immediate: true, panning: pan });
    }
    
    // Fallback to live TTS generation
    log(`[playTextEarcon] Generating TTS for "${spokenText}"`);
    try {
        const { genTokenAudio } = require('./tts');
        const audioPath = await genTokenAudio(spokenText, 'earcon_text');
        const { playWave } = require('./audio');
        return playWave(audioPath, { isEarcon: true, immediate: true, panning: pan });
    } catch (error) {
        log(`[playTextEarcon] TTS generation failed for "${spokenText}": ${error instanceof Error ? error.message : String(error)}`);
        return Promise.resolve();
    }
}

/**
 * Find pre-generated text earcon sound file
 */
function findTextEarconSound(token: string): string | null {
    // Map token to filename (same as charToFileName in generation script)
    const charToFileName: Record<string, string> = {
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
        '_': 'underscore',
        '-': 'minus',
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
    
    const fileName = charToFileName[token];
    if (!fileName) {
        return null;
    }
    
    // Use backend-specific text earcon directory
    const { currentBackend, TTSBackend } = require('./config');
    let textEarconDirName = 'special_espeak_text';
    if (currentBackend === TTSBackend.MacOS || currentBackend === TTSBackend.MacOSGPT) {
        textEarconDirName = 'special_macos_text';
    } else if (currentBackend === TTSBackend.SileroGPT) {
        textEarconDirName = 'special_silero_text';
    }
    
    const textEarconDir = path.join(config.audioPath(), textEarconDirName);
    const pcmPath = path.join(textEarconDir, `${fileName}.pcm`);
    const wavPath = path.join(textEarconDir, `${fileName}.wav`);
    
    // Prefer PCM, fallback to WAV
    if (fs.existsSync(pcmPath)) {
        return pcmPath;
    }
    if (fs.existsSync(wavPath)) {
        return wavPath;
    }
    
    return null;
}

/**
 * Play an earcon token using cached PCM data
 */
export function playEarcon(token: string, pan?: number): Promise<void> {
    log(`[playEarcon] Starting playback for token: "${token}" with panning: ${pan}`);
    
    // Check earcon mode and decide whether to use text or sound
    if (earconModeState.mode === EarconMode.Text && earconTextMap[token]) {
        log(`[playEarcon] Text mode enabled, using TTS for "${token}" → "${earconTextMap[token]}"`);
        return playTextEarcon(token, pan);
    } else if (earconModeState.mode === EarconMode.ParenthesesOnly && earconTextMap[token]) {
        // In ParenthesesOnly mode, use earcon sounds for ( ), and enter, text for everything else
        if (token === '(' || token === ')' || token === 'enter') {
            log(`[playEarcon] ParenthesesOnly mode: using earcon sound for "${token}"`);
            // Continue to regular earcon playback below
        } else {
            log(`[playEarcon] ParenthesesOnly mode: using TTS for "${token}" → "${earconTextMap[token]}"`);
            return playTextEarcon(token, pan);
        }
    }
    
    const file = findTokenSound(token);
    log(`[playEarcon] findTokenSound("${token}") returned: ${file}`);
    
    if (!file) {
        log(`[playEarcon] No earcon file found for token: "${token}", resolving immediately`);
        // no earcon mapped
        return Promise.resolve();
    }

    // If the resolved earcon is a WAV file, play it directly at neutral rate (no pitch change)
    // This avoids any time-stretching or sample-rate tricks that could alter pitch
    const ext = path.extname(file).toLowerCase();
    if (ext === '.wav') {
        const { playWave } = require('./audio');
        // Let playWave use global playspeed (with pitch preservation if enabled)
        return playWave(file, { isEarcon: true, immediate: true, panning: pan });
    }

    // For pitch-preserving earcons, convert PCM to WAV and use time stretching
    // Exception: Only optimize space character specifically for minimal delay
    const isSpaceToken = token === ' ';
    
    // For earcons, use pitch-preserving time stretching when playspeed is not 1.0
    // This ensures earcons play at correct speed while preserving pitch
    if (config.preservePitch && Math.abs(config.playSpeed - 1.0) > 0.01 && !isSpaceToken) {
        log(`[playEarcon] Using pitch-preserving time stretching for earcon "${token}"`);
        
        // Lazy-load the raw file once with memory management
        if (!earconRaw[token]) {
            log(`[playEarcon] Loading earcon file for first time: ${file}`);
            cleanupEarconCache();
            
            try {
                const data = fs.readFileSync(file!); // file is guaranteed to be non-null here
                earconRaw[token] = data;
                earconAccessTimes[token] = Date.now();
                log(`[playEarcon] Successfully loaded earcon data for "${token}": ${data.length} bytes`);
            } catch (err) {
                log(`[playEarcon] Failed to load earcon file ${file}: ${err}`);
                return Promise.resolve();
            }
        } else {
            log(`[playEarcon] Using cached earcon data for "${token}"`);
            earconAccessTimes[token] = Date.now();
        }
        
        // Convert PCM to temporary WAV file for FFmpeg processing
        const tempDir = path.join(os.tmpdir(), 'lipcoder_earcon');
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }
        // Create safe filename by replacing special characters
        const safeToken = token.replace(/[^a-zA-Z0-9]/g, '_');
        const tempWavPath = path.join(tempDir, `earcon_${safeToken}_${Date.now()}.wav`);
        try {
            // Create WAV header for the PCM data
            const pcmData = earconRaw[token];
            const format = STANDARD_PCM_FORMAT;
            
            // Create a simple WAV file with header
            const wavHeader = Buffer.alloc(44);
            wavHeader.write('RIFF', 0);
            wavHeader.writeUInt32LE(36 + pcmData.length, 4);
            wavHeader.write('WAVE', 8);
            wavHeader.write('fmt ', 12);
            wavHeader.writeUInt32LE(16, 16); // fmt chunk size
            wavHeader.writeUInt16LE(1, 20);  // PCM format
            wavHeader.writeUInt16LE(format.channels, 22);
            wavHeader.writeUInt32LE(format.sampleRate, 24);
            wavHeader.writeUInt32LE(format.sampleRate * format.channels * (format.bitDepth / 8), 28);
            wavHeader.writeUInt16LE(format.channels * (format.bitDepth / 8), 32);
            wavHeader.writeUInt16LE(format.bitDepth, 34);
            wavHeader.write('data', 36);
            wavHeader.writeUInt32LE(pcmData.length, 40);
            
            const wavData = Buffer.concat([wavHeader, pcmData]);
            fs.writeFileSync(tempWavPath, wavData);
            
            // Use the regular playWave function which will handle pitch-preserving time stretching
            const { playWave } = require('./audio');
            // Use global playspeed; audio.ts will pitch-preserve when enabled
            return playWave(tempWavPath, { isEarcon: true, immediate: true, panning: pan })
                .finally(() => {
                    // Clean up temp file
                    try { fs.unlinkSync(tempWavPath); } catch { }
                });
                
        } catch (err) {
            log(`[playEarcon] Failed to create temp WAV for pitch preservation: ${err}, falling back to sample rate adjustment`);
            // Clean up temp file if it was created
            try { fs.unlinkSync(tempWavPath); } catch { }
            // Fall through to original method below
        }
    }

    // Special handling for space with pitch-preserving enabled - use fast sample rate method
    if (isSpaceToken && config.preservePitch && Math.abs(config.playSpeed - 1.0) > 0.01) {
        log(`[playEarcon] Using FAST sample-rate method for space (preserving some pitch characteristics)`);
    }
    
    // Original method with sample rate adjustment (changes pitch)
    
    // For space character specifically, skip caching and read directly for minimal latency
    let rawData: Buffer;
    
    if (isSpaceToken) {
        // Direct read for immediate playback - skip cache for minimal delay
        try {
            rawData = fs.readFileSync(file!); // file is guaranteed to be non-null here
            log(`[playEarcon] DIRECT READ for space earcon: ${rawData.length} bytes`);
        } catch (err) {
            log(`[playEarcon] Failed to read space earcon file ${file}: ${err}`);
            return Promise.resolve();
        }
    } else {
        // Lazy-load the raw file once with memory management for other earcons
        if (!earconRaw[token]) {
            log(`[playEarcon] Loading earcon file for first time: ${file}`);
            // Check if we need to clean up cache first
            cleanupEarconCache();
            
            try {
                const data = fs.readFileSync(file!); // file is guaranteed to be non-null here
                earconRaw[token] = data;
                earconAccessTimes[token] = Date.now();
                log(`[playEarcon] Successfully loaded earcon data for "${token}": ${data.length} bytes`);
            } catch (err) {
                log(`[playEarcon] Failed to load earcon file ${file}: ${err}`);
                return Promise.resolve();
            }
        } else {
            log(`[playEarcon] Using cached earcon data for "${token}"`);
            // Update access time
            earconAccessTimes[token] = Date.now();
        }
        rawData = earconRaw[token];
    }

    const format = STANDARD_PCM_FORMAT;
    let finalPcm = rawData;
    
    // Pre-apply panning if needed
    if (pan !== undefined && pan !== 0) {
        finalPcm = applyEarconPanning(rawData, format, pan);
        log(`[playEarcon] Applied panning ${pan.toFixed(3)} to "${token}"`);
    }
    
    return new Promise<void>((resolve, reject) => {
        // Stop any current earcon playback
        stopEarconPlayback();
        
        // When pitch-preserving fails, apply global playspeed via sample-rate change
        const adjustedFormat = { ...format, sampleRate: Math.floor(format.sampleRate * Math.max(0.1, config.playSpeed)) } as any;
        
        if (isSpaceToken) {
            log(`[playEarcon] FAST SPACE: sample rate ${adjustedFormat.sampleRate}Hz for ultra-low latency`);
        } else {
            log(`[playEarcon] Using normal sample rate ${adjustedFormat.sampleRate}Hz for immediate earcon feedback`);
        }
        
        // Use smaller buffer for space earcon to reduce latency
        const bufferSize = isSpaceToken ? 16 : 128; // Ultra-small buffer for space earcon
        
        // @ts-ignore: samplesPerFrame used for low-latency despite missing in type
        const speaker = new Speaker({ ...adjustedFormat, samplesPerFrame: bufferSize } as any);
        currentSpeaker = speaker;
        
        speaker.on('close', () => {
            log(`[playEarcon] Sample rate adjustment playback completed for token: "${token}"`);
            resolve();
        });
        speaker.on('error', (err) => {
            log(`[playEarcon] Speaker error for "${token}": ${err}`);
            // Fallback to external player
            let cmd: string, args: string[];
            if (process.platform === 'darwin') {
                cmd = 'afplay'; args = [file];
            } else if (process.platform === 'win32') {
                cmd = 'powershell'; args = ['-c', `(New-Object Media.SoundPlayer '${file}').PlaySync();`];
            } else {
                cmd = 'play'; args = [file];
            }
            const cp = hookChildErrors(spawn(cmd, args, { stdio: 'ignore' }));
            currentFallback = cp;
            cp.on('close', () => resolve());
        });
        
        if (isSpaceToken) {
            log(`[playEarcon] ⚡ ULTRA-FAST SPACE: ${finalPcm.length} bytes, ${bufferSize}-sample buffer, no-cache, no-FFmpeg`);
        } else {
            log(`[playEarcon] Writing ${finalPcm.length} bytes for token: "${token}"`);
        }
        
        speaker.write(finalPcm);
        speaker.end();
    });
}

/**
 * Stop any currently playing earcon
 */
export function stopEarconPlayback(): void {
    if (currentSpeaker) {
        try {
            // force-kill the speaker stream immediately
            currentSpeaker.destroy();
        } catch { }
        currentSpeaker = null;
    }
    if (currentFallback) {
        try { currentFallback.kill('SIGKILL'); } catch { }
        currentFallback = null;
    }
}

/**
 * Check if a token is an earcon
 */
export function isEarconToken(token: string): boolean {
    return isEarcon(token) || !!findTokenSound(token);
} 