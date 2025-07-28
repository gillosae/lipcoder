import * as fs from 'fs';
import * as path from 'path';
import Speaker from 'speaker';
import { spawn, ChildProcess } from 'child_process';
import { getTokenSound } from './tokens';
import { log, logWarning, logMemory } from './utils';
import { config } from './config';
import { isEarcon, specialCharMap } from './mapping';

// Standard PCM format for earcon playback
const STANDARD_PCM_FORMAT = {
    channels: 2,        // stereo (converted from mono)
    sampleRate: 24000,   // 24kHz (original sample rate)
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
    const specialName = specialCharMap[token];
    if (specialName) {
        // First check the "special" folder (underbar, equals, etc.)
        const specialFile = path.join(config.specialPath(), `${specialName}.pcm`);
        if (fs.existsSync(specialFile)) return specialFile;
        // Then fall back to the earcon folder (for punctuation like bigquote)
        const fallbackEarcon = path.join(config.earconPath(), `${specialName}.pcm`);
        if (fs.existsSync(fallbackEarcon)) return fallbackEarcon;
    }

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
 * Play an earcon token using cached PCM data
 */
export function playEarcon(token: string, pan?: number): Promise<void> {
    log(`[playEarcon] Starting playback for token: "${token}" with panning: ${pan}`);
    
    const file = findTokenSound(token);
    log(`[playEarcon] findTokenSound("${token}") returned: ${file}`);
    
    if (!file) {
        log(`[playEarcon] No earcon file found for token: "${token}", resolving immediately`);
        // no earcon mapped
        return Promise.resolve();
    }

    // Lazy-load the raw file once with memory management
    if (!earconRaw[token]) {
        log(`[playEarcon] Loading earcon file for first time: ${file}`);
        // Check if we need to clean up cache first
        cleanupEarconCache();
        
        try {
            const data = fs.readFileSync(file);
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

    const format = STANDARD_PCM_FORMAT;
    let finalPcm = earconRaw[token];

    // Apply panning if specified
    if (pan !== undefined && pan !== 0) {
        log(`[playEarcon] Applied panning ${pan.toFixed(2)} to earcon "${token}"`);
        finalPcm = applyEarconPanning(finalPcm, format, pan);
    }

    log(`[playEarcon] About to create Speaker for earcon "${token}"`);
    
    return new Promise<void>((resolve, reject) => {
        log(`[playEarcon] Creating Speaker instance for "${token}"`);
        
        try {
            // Stop any current earcon playback
            stopEarconPlayback();
            
            // @ts-ignore: samplesPerFrame used for low-latency despite missing in type
            const speaker = new Speaker({ ...format, samplesPerFrame: 128 } as any);
            currentSpeaker = speaker;
            
            log(`[playEarcon] Speaker created successfully for "${token}"`);
            
            speaker.on('close', () => {
                log(`[playEarcon] Speaker closed for "${token}"`);
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
            
            log(`[playEarcon] Writing PCM data to speaker for "${token}": ${finalPcm.length} bytes`);
            speaker.write(finalPcm);
            speaker.end();
            log(`[playEarcon] PCM data written and speaker ended for "${token}"`);
        } catch (err) {
            log(`[playEarcon] Exception in Speaker creation for "${token}": ${err}`);
            reject(err);
        }
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