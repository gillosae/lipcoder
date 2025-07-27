import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as wav from 'wav';
import Speaker from 'speaker';
import { spawn, ChildProcess } from 'child_process';
import { Readable } from 'stream';
import { log } from './utils';
import { config } from './config';
import { isAlphabet, isNumber } from './mapping';

// Import from the new modules
import { playEarcon, stopEarconPlayback, isEarconToken, findTokenSound, earconRaw } from './earcon';
import { genTokenAudio, playSpecial, isTTSRequired, getSpeakerForCategory, specialWordCache } from './tts';

// Re-export functions that other modules expect from audio.ts
export { genTokenAudio, playSpecial, specialWordCache } from './tts';
export { playEarcon, earconRaw } from './earcon';

let currentSpeaker: Speaker | null = null;
let currentFallback: ChildProcess | null = null;
let currentReader: wav.Reader | null = null;
let currentFileStream: fs.ReadStream | null = null;

// Cache for arbitrary PCM files for immediate playback
const pcmCache: Record<string, { format: any; pcm: Buffer }> = {};

// Standard PCM format for all audio files (matches conversion script output)
const STANDARD_PCM_FORMAT = {
    channels: 2,        // stereo
    sampleRate: 48000,   // 48kHz (matches actual audio files)
    bitDepth: 16,       // 16-bit
    signed: true,
    float: false
};

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

// Immediate external playback for low-latency abortable audio
function playImmediate(filePath: string): Promise<void> {
    // Kill any in-flight audio first
    stopPlayback();
    // Choose platform player
    let cmd: string, args: string[];
    if (process.platform === 'darwin') {
        cmd = 'afplay'; args = [filePath];
    } else if (process.platform === 'win32') {
        cmd = 'powershell'; args = ['-c', `(New-Object Media.SoundPlayer '${filePath}').PlaySync();`];
    } else {
        // Linux and others; use SoX 'play'
        cmd = 'play'; args = [filePath];
    }
    const cp = hookChildErrors(spawn(cmd, args, { stdio: 'ignore' }));
    currentFallback = cp;
    return new Promise<void>(resolve => cp.on('close', () => resolve()));
}

function playCachedPcm(filePath: string): Promise<void> {
    // Load and cache PCM data if needed
    let entry = pcmCache[filePath];
    if (!entry) {
        const pcm = fs.readFileSync(filePath);
        entry = { format: STANDARD_PCM_FORMAT, pcm };
        pcmCache[filePath] = entry;
    }
    return new Promise<void>((resolve, reject) => {
        // Halt any prior playback
        stopPlayback();
        // @ts-ignore: samplesPerFrame used for low-latency despite missing in type
        const speaker = new Speaker({ ...entry.format, samplesPerFrame: 128 } as any);
        currentSpeaker = speaker;
        speaker.on('close', resolve);
        speaker.on('error', reject);
        speaker.write(entry.pcm);
        speaker.end();
    });
}

// ── Speak a token (generate + play) ───────────────────────────────────────────
export async function speakToken(
    token: string,
    category?: string,
    opts?: { speaker?: string; signal?: AbortSignal }
): Promise<void> {
    try {
        log(`[speakToken] token="${token}" category="${category}"`);
        let playPromise: Promise<void>;
        
        if (isAlphabet(token)) {
            const lower = token.toLowerCase();
            const alphaPath = path.join(config.alphabetPath(), `${lower}.pcm`);
            if (fs.existsSync(alphaPath)) {
                playPromise = playCachedPcm(alphaPath);
            } else {
                const filePath = await genTokenAudio(token, category, { speaker: opts?.speaker ?? getSpeakerForCategory(category) });
                playPromise = playWave(filePath);
            }
        } else if (isNumber(token)) {
            const numPath = path.join(config.numberPath(), `${token}.pcm`);
            if (fs.existsSync(numPath)) {
                playPromise = playCachedPcm(numPath);
            } else {
                const filePath = await genTokenAudio(token, category, { speaker: opts?.speaker ?? getSpeakerForCategory(category) });
                playPromise = playWave(filePath);
            }
        } else if (isEarconToken(token)) {
            playPromise = playEarcon(token);
        } else if (isTTSRequired(token)) {
            const speakerName = opts?.speaker ?? getSpeakerForCategory(category);
            const filePath = await genTokenAudio(token, category, { speaker: speakerName });
            playPromise = playWave(filePath);
        } else {
            // Skip blanks or unknown tokens
            return Promise.resolve();
        }
        
        // Just return the play promise - abort handling is done at speakTokenList level
        return await playPromise;
    } catch (err: any) {
        log(`[speakToken] Error handling token "${token}": ${err.stack || err}`);
    }
}

export type TokenChunk = {
    tokens: string[];
    category?: string;
};

export async function speakTokenList(chunks: TokenChunk[], signal?: AbortSignal): Promise<void> {
    for (const { tokens, category } of chunks) {
        for (const token of tokens) {
            if (signal?.aborted) return;
            const playPromise = speakToken(token, category);
            if (signal) {
                try {
                    await Promise.race([
                        playPromise,
                        new Promise<void>((_, reject) => {
                            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
                        })
                    ]);
                } catch {
                    return; // Stop immediately on abort
                }
            } else {
                await playPromise;
            }
        }
    }
}

// ── Play a WAV file by streaming its PCM to the speaker, avoiding any external process spawns. ──────────
let playQueue = Promise.resolve();

// Helper to perform WAV playback immediately without queueing
function doPlay(filePath: string, opts?: { isEarcon?: boolean; rate?: number }): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const fileStream = fs.createReadStream(filePath);
        currentFileStream = fileStream;
        const reader = new wav.Reader();
        currentReader = reader;
        let fallback = false;
        function doFallback(err: any) {
            log(`🛑 wav-stream error: ${err.stack || err}`);
            if (fallback) return;
            fallback = true;
            reader.removeAllListeners();
            fileStream.unpipe(reader);
            fileStream.destroy();
            let cmd: string, args: string[];
            if (process.platform === 'darwin') {
                cmd = 'afplay'; args = [filePath];
            } else if (process.platform === 'win32') {
                cmd = 'powershell'; args = ['-c', `(New-Object Media.SoundPlayer '${filePath}').PlaySync();`];
            } else if (process.platform === 'linux') {
                cmd = 'play'; args = [filePath];
            } else {
                cmd = 'aplay'; args = [filePath];
            }
            const p = hookChildErrors(spawn(cmd, args, { stdio: 'ignore' }));
            currentFallback = p;
            p.on('close', (code) => {
                currentFallback = null;
                if (code === 0 || code === null) resolve(); else reject(new Error(`fallback player ${code}`));
            });
        }
        reader.on('format', (format: any) => {
            log(`🔊 got format: ${JSON.stringify(format)}`);
            try {
                const adjusted = { ...format };
                if (opts?.rate !== undefined) adjusted.sampleRate = Math.floor(format.sampleRate * opts.rate!);
                else if (opts?.isEarcon) adjusted.sampleRate = Math.floor(format.sampleRate * 2.4);
                if (currentSpeaker) { try { currentSpeaker.end(); } catch { } currentSpeaker = null; }
                if (currentFallback) { try { currentFallback.kill(); } catch { } currentFallback = null; }
                // @ts-ignore: samplesPerFrame used for low-latency despite missing in type
                const speaker = new Speaker({ ...adjusted, samplesPerFrame: 128 } as any);
                currentSpeaker = speaker;
                reader.pipe(speaker);
                speaker.on('close', resolve);
                speaker.on('error', err => { log(`🛑 Speaker error: ${err.stack || err}`); reject(err); });
            } catch (err) {
                doFallback(err);
            }
        });
        reader.on('error', doFallback);
        fileStream.on('error', doFallback);
        fileStream.pipe(reader);
    });
}

export function playWave(
    filePath: string,
    opts?: { isEarcon?: boolean; rate?: number; immediate?: boolean }
): Promise<void> {
    // Skip playback if the file doesn't exist
    if (!fs.existsSync(filePath)) {
        log(`🔕 playWave skipping missing file: ${filePath}`);
        return Promise.resolve();
    }

    // Determine if this is a PCM file or WAV file
    const isPcmFile = filePath.toLowerCase().endsWith('.pcm');
    
    if (isPcmFile) {
        // Handle PCM files directly
        return playPcm(filePath, opts);
    }
    
    // Handle WAV files (for backward compatibility with TTS-generated files)
    if (opts?.immediate) {
        const p = playImmediate(filePath);
        playQueue = p.catch(() => { });
        return p;
    }
    
    // 1) If this is an earcon, bypass wav.Reader completely
    if (opts?.isEarcon) {
        log(`[playWave] Playing earcon via raw PCM cache: ${filePath}`);
        // Determine token and use playEarcon
        const fname = path.basename(filePath, '.wav');
        // Try to find a token that maps to this filename
        const token = fname;
        if (findTokenSound(token)) {
            return playEarcon(token);
        }
        // Fallback to wav.Reader if not found
    }

    // 2) Otherwise, your existing wav.Reader → Speaker logic…
    playQueue = playQueue.then(() => doPlay(filePath, opts));
    return playQueue;
}

// New function to handle PCM files directly
function playPcm(filePath: string, opts?: { isEarcon?: boolean; rate?: number; immediate?: boolean }): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        try {
            const pcmData = fs.readFileSync(filePath);
            let format = { ...STANDARD_PCM_FORMAT };
            
            // Apply rate adjustment if specified
            if (opts?.rate !== undefined) {
                format.sampleRate = Math.floor(format.sampleRate * opts.rate);
            } else if (opts?.isEarcon) {
                format.sampleRate = Math.floor(format.sampleRate * 2.4);
            }
            
            // Halt any prior playback
            stopPlayback();
            
            // @ts-ignore: samplesPerFrame used for low-latency despite missing in type
            const speaker = new Speaker({ ...format, samplesPerFrame: 128 } as any);
            currentSpeaker = speaker;
            
            speaker.on('close', resolve);
            speaker.on('error', (err) => {
                log(`🛑 PCM Speaker error: ${err.stack || err}`);
                reject(err);
            });
            
            speaker.write(pcmData);
            speaker.end();
        } catch (err) {
            log(`🛑 PCM playback error: ${err}`);
            reject(err);
        }
    });
}

// ── (Unused) Tone generator ───────────────────────────────────────────────────
export function generateTone(
    duration = 200,
    freq = 440
): Promise<void> {
    const sampleRate = 44100;
    const total = Math.floor((sampleRate * duration) / 1000);
    return new Promise((resolve, reject) => {
        const speaker = new Speaker({ channels: 1, bitDepth: 16, sampleRate });
        let i = 0;
        const stream = new Readable({
            read() {
                if (i < total) {
                    const t = i++ / sampleRate;
                    const amp = Math.sin(2 * Math.PI * freq * t) * 32767;
                    const buf = Buffer.alloc(2);
                    buf.writeInt16LE(amp, 0);
                    this.push(buf);
                } else {
                    this.push(null);
                }
            },
        });
        stream.pipe(speaker);
        speaker.on('close', resolve);
        speaker.on('error', reject);
    });
}

/**
 * Immediately aborts any in‐flight audio (earcon or fallback).
 */
export function stopPlayback(): void {
    // Stop earcon playback
    stopEarconPlayback();
    
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
    // Abort any active WAV streams
    if (currentReader) { try { currentReader.destroy(); } catch { } currentReader = null; }
    if (currentFileStream) { try { currentFileStream.close(); } catch { } currentFileStream = null; }
    // Clear any queued playback tasks
    playQueue = Promise.resolve();
}

/**
 * Play multiple WAV files back-to-back with zero latency by concatenating PCM.
 * If opts.rate is given and not 1, use SoX to time-stretch without pitch change.
 */
export async function playSequence(
    filePaths: string[],
    opts?: { rate?: number }
): Promise<void> {
    // Filter out missing files before playback
    const existingFiles = filePaths.filter(fp => {
        if (!fs.existsSync(fp)) {
            log(`🔕 playSequence skipping missing file: ${fp}`);
            return false;
        }
        return true;
    });
    // Use existingFiles from now on
    filePaths = existingFiles;
    if (filePaths.length === 0) return;
    // Use SoX for time-stretching with pitch preservation if rate !== 1
    if (opts?.rate && opts.rate !== 1) {
        // Use SoX to play files concatenated with tempo adjustment to maintain pitch
        const cmd = 'sox';
        const args = [...filePaths, '-d', 'tempo', String(opts.rate)];
        const cp = hookChildErrors(spawn(cmd, args, { stdio: 'ignore' }));
        return new Promise<void>((resolve, reject) => {
            currentFallback = cp;
            cp.on('close', code => {
                currentFallback = null;
                if (code === 0 || code === null) resolve();
                else reject(new Error(`sox tempo player exited ${code}`));
            });
        });
    }
    // Raw PCM concatenation for rate === 1
    const entries = filePaths.map(filePath => {
        const isPcmFile = filePath.toLowerCase().endsWith('.pcm');
        
        if (isPcmFile) {
            // PCM files are raw data, no header parsing needed
            const pcm = fs.readFileSync(filePath);
            return {
                format: STANDARD_PCM_FORMAT,
                pcm
            };
        } else {
            // WAV files (for backward compatibility)
            const buf = fs.readFileSync(filePath);
            // Header offsets: channels @22 (UInt16LE), sampleRate @24 (UInt32LE), bitsPerSample @34 (UInt16LE)
            const channels = buf.readUInt16LE(22);
            const sampleRate = buf.readUInt32LE(24);
            const bitDepth = buf.readUInt16LE(34);

            // Find the "data" tag, then skip the next 4 bytes (size) to get to PCM data
            const dataIdx = buf.indexOf(Buffer.from('data'));
            if (dataIdx < 0) throw new Error(`No data chunk in ${filePath}`);
            const pcm = buf.slice(dataIdx + 8);

            return {
                format: {
                    channels,
                    sampleRate,
                    bitDepth,
                    signed: true,
                    float: false
                },
                pcm
            };
        }
    });

    // Concatenate all PCM into one buffer
    const allPCM = Buffer.concat(entries.map(e => e.pcm));
    const fmt = entries[0].format;

    // Play it back in a single Speaker instance
    return new Promise<void>((resolve, reject) => {
        const speaker = new Speaker(fmt);
        speaker.on('close', resolve);
        speaker.on('error', reject);
        speaker.write(allPCM);
        speaker.end();
    });
}