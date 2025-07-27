import * as fs from 'fs';
import * as path from 'path';
import Speaker from 'speaker';
import { spawn, ChildProcess } from 'child_process';
import { getTokenSound } from './tokens';
import { log } from './utils';
import { config } from './config';
import { isEarcon, specialCharMap } from './mapping';

// Cache for each token: { format, pcmBuffer }
interface EarconData { format: any; pcm: Buffer }
export const earconRaw: Record<string, Buffer> = {};

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
    const rightGain = pan >= 0 ? 1 : 1 + pan;
    
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
    const file = findTokenSound(token);
    if (!file) {
        // no earcon mapped
        return Promise.resolve();
    }

    // Lazy-load the raw file once
    if (!earconRaw[token]) {
        earconRaw[token] = fs.readFileSync(file);
    }
    const buf = earconRaw[token];
    
    let pcm: Buffer;
    let fmt: any;
    
    const isPcmFile = file.toLowerCase().endsWith('.pcm');
    
    if (isPcmFile) {
        // PCM files are raw data, no header parsing needed
        pcm = buf;
        fmt = {
            channels: 2,        // stereo (from conversion script)
            sampleRate: 48000,  // 48kHz (matches actual audio files)
            bitDepth: 16,       // 16-bit
            signed: true,
            float: false
        };
    } else {
        // WAV files (for backward compatibility)
        // Parse header fields: channels @22, sampleRate @24, bitDepth @34
        const channels = buf.readUInt16LE(22);
        const sampleRate = buf.readUInt32LE(24);
        const bitDepth = buf.readUInt16LE(34);
        // Locate the "data" subchunk (skipping any extra chunks) and slice out PCM
        const dataIdx = buf.indexOf(Buffer.from('data'));
        if (dataIdx < 0) throw new Error(`No data chunk in earcon ${file}`);
        pcm = buf.slice(dataIdx + 8);
        // Include signed/float flags for Speaker
        fmt = { channels, sampleRate, bitDepth, signed: true, float: false };
    }

    return new Promise((resolve) => {
        try {
            // Apply panning if specified
            let finalPcm = pcm;
            if (pan !== undefined && pan !== 0) {
                finalPcm = applyEarconPanning(pcm, fmt, pan);
                log(`[playEarcon] Applied panning ${pan.toFixed(2)} to earcon "${token}"`);
            }
            
            // @ts-ignore: samplesPerFrame used for low-latency despite missing in type
            const speaker = new Speaker({ ...fmt, samplesPerFrame: 128 } as any);
            // Track this earcon speaker for stopPlayback()
            currentSpeaker = speaker;
            speaker.on('error', (err) => {
                log(`[playEarcon] Speaker error: ${err.stack || err}`);
                // Fallback to external player
                let cmd: string, args: string[];
                if (process.platform === 'darwin') {
                    cmd = 'afplay'; args = [file];
                } else if (process.platform === 'win32') {
                    cmd = 'powershell'; args = ['-c', `(New-Object Media.SoundPlayer '${file}').PlaySync();`];
                } else if (process.platform === 'linux') {
                    cmd = 'aplay'; args = [file];
                } else {
                    cmd = 'aplay'; args = [file];
                }
                const cp = hookChildErrors(spawn(cmd, args, { stdio: 'ignore' }));
                currentFallback = cp;
                cp.on('close', () => resolve());
            });
            speaker.on('close', () => resolve());
            speaker.write(finalPcm);
            speaker.end();
        } catch (err: any) {
            log(`[playEarcon] Exception: ${err.stack || err}`);
            // Fallback external
            let cmd: string, args: string[];
            if (process.platform === 'darwin') {
                cmd = 'afplay'; args = [file];
            } else if (process.platform === 'win32') {
                cmd = 'powershell'; args = ['-c', `(New-Object Media.SoundPlayer '${file}').PlaySync();`];
            } else if (process.platform === 'linux') {
                cmd = 'aplay'; args = [file];
            } else {
                cmd = 'aplay'; args = [file];
            }
            const cp = hookChildErrors(spawn(cmd, args, { stdio: 'ignore' }));
            currentFallback = cp;
            cp.on('close', () => resolve());
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