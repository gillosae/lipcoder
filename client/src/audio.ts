import * as fs from 'fs';
import * as path from 'path';
import Speaker from 'speaker';
import * as wav from 'wav';
import { spawn, ChildProcess } from 'child_process';
import * as os from 'os';
import { Readable } from 'stream';
import { earconTokens, getTokenSound } from './tokens';
// import { stopPlayback } from './audio';
import { log } from './utils';

import { config } from './config';
import { numberMap, isAlphabet, isEarcon, isNumber, isSpecial, specialCharMap } from './mapping';
import { fetch, Agent } from 'undici';


// Keep-alive agent for HTTP fetch to reuse connections
const keepAliveAgent = new Agent({ keepAliveTimeout: 60000 });

let currentSpeaker: Speaker | null = null;
let currentFallback: ChildProcess | null = null;
let currentReader: wav.Reader | null = null;
let currentFileStream: fs.ReadStream | null = null;

// ── TTS Backends & Config ─────────────────────────────────────────────────────
export enum TTSBackend {
    Silero = 'silero',
    Espeak = 'espeak',
}

export interface SileroConfig {
    pythonPath: string;
    scriptPath: string;
    language: string;
    modelId: string;
    defaultSpeaker?: string;
    sampleRate: number;
}

let currentBackend = TTSBackend.Silero;
let sileroConfig: SileroConfig = {
    pythonPath: '',
    scriptPath: '',
    language: 'en',
    modelId: 'v3_en',
    defaultSpeaker: 'en_3',
    sampleRate: 8000,
};


const categoryVoiceMap: Record<string, string> = {
    variable: 'en_3',
    operator: 'en_15',
    keyword: 'en_35',
    literal: 'en_5',
    comment: 'en_41',
    type: 'en_80',
};


// ──  ──────────────────────────────────────────────────
function findTokenSound(token: string): string | null {
    const primary = getTokenSound(token);
    if (primary) return primary;

    const lower = token.toLowerCase();
    // Alphabet folder (letters)
    const alphaPath = path.join(config.alphabetPath(), `${lower}.wav`);
    if (fs.existsSync(alphaPath)) return alphaPath;

    // Number folder (digits)
    const numPath = path.join(config.numberPath(), `${lower}.wav`);
    if (fs.existsSync(numPath)) return numPath;

    // Special‐tokens folder: map single-char token to its spoken name
    const specialName = specialCharMap[token];
    if (specialName) {
        // First check the “special” folder (underbar, equals, etc.)
        const specialFile = path.join(config.specialPath(), `${specialName}.wav`);
        if (fs.existsSync(specialFile)) return specialFile;
        // Then fall back to the earcon folder (for punctuation like bigquote)
        const fallbackEarcon = path.join(config.earconPath(), `${specialName}.wav`);
        if (fs.existsSync(fallbackEarcon)) return fallbackEarcon;
    }

    return null;
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

function hookChildErrors(cp: ChildProcess) {
    cp.on('error', err => {
        log(`🔊 player “error” event: ${err.stack || err}`);
    });
    if (cp.stderr) {
        cp.stderr.on('data', chunk => {
            log(`🔊 player stderr: ${chunk.toString().trim()}`);
        });
    }
    return cp;
}

// Cache for each token: { format, pcmBuffer }
interface EarconData { format: any; pcm: Buffer }
const earconCache: Record<string, EarconData> = {};

// Cache for arbitrary WAV files for immediate playback
const wavCache: Record<string, { format: any; pcm: Buffer }> = {};

function playCachedWav(filePath: string): Promise<void> {
    // Load and cache PCM+format if needed
    let entry = wavCache[filePath];
    if (!entry) {
        const buf = fs.readFileSync(filePath);
        const channels = buf.readUInt16LE(22);
        const sampleRate = buf.readUInt32LE(24);
        const bitDepth = buf.readUInt16LE(34);
        const dataIdx = buf.indexOf(Buffer.from('data'));
        if (dataIdx < 0) throw new Error(`No data chunk in ${filePath}`);
        const pcm = buf.slice(dataIdx + 8);
        entry = { format: { channels, sampleRate, bitDepth, signed: true, float: false }, pcm };
        wavCache[filePath] = entry;
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

// Cache for special-word TTS audio (format + PCM)
export const specialWordCache: Record<string, EarconData> = {};
/** Decode each special-word TTS once and stash in memory */

/** Play a preloaded special-word from memory */
export function playSpecial(word: string): Promise<void> {
    log(`[playSpecial] word="${word}" cached=${!!specialWordCache[word]}`);
    const entry = specialWordCache[word];
    if (!entry) {
        // fallback to file-based playback
        log(`[playSpecial] fallback to file-based playback for "${word}"`);
        const cacheDir = path.join(os.tmpdir(), 'lipcoder_tts_cache');
        const sanitized = word.toLowerCase().replace(/[^a-z0-9]+/g, '_');
        const file = path.join(cacheDir, `text_${sanitized}.wav`);
        log(`[playSpecial] fallback file=${file}, exists=${fs.existsSync(file)}`);
        return playWave(file, { isEarcon: true });
    }
    return new Promise((resolve, reject) => {
        const speaker = new Speaker(entry.format);
        speaker.on('error', reject);
        speaker.on('close', resolve);
        speaker.write(entry.pcm);
        speaker.end();
    });
}

// ── Configure TTS backend (Silero or Espeak) ─────────────────────────────────
export function setBackend(
    backend: TTSBackend,
    config?: Partial<SileroConfig>
) {
    currentBackend = backend;
    if (backend === TTSBackend.Silero && config) {
        sileroConfig = { ...sileroConfig, ...(config as SileroConfig) };
    }
}

// ── Generate (but don’t play) audio for a token ───────────────────────────────
export async function genTokenAudio(
    token: string,
    category?: string,
    opts?: { speaker?: string }
): Promise<string> {
    log(`[genTokenAudio] START token="${token}" category="${category}"`);

    // 0) Pre-generated keyword audio?
    if (category && category.startsWith('keyword_')) {
        const lang = category.split('_')[1];      // “python” or “typescript”
        const filename = token.toLowerCase();     // match your saved filenames
        const filePath = path.join(config.earconPath(), lang, `${filename}.wav`);
        log(`[genTokenAudio] looking up keyword WAV at ${filePath}, exists=${fs.existsSync(filePath)}`);
        if (fs.existsSync(filePath)) {
            log(`[genTokenAudio] keyword bypass: using pre-generated audio at ${filePath}`);
            return filePath;  // skip TTS entirely
        }
    }

    // 0.5) Cache multi-character tokens to avoid re-generating TTS repeatedly
    const cacheDir = path.join(os.tmpdir(), 'lipcoder_tts_cache');
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
    if (token.length > 1) {
        // sanitize the token to a filesystem-safe name
        const sanitized = token.toLowerCase().replace(/[^a-z0-9]+/g, '_');
        const cachedFile = path.join(cacheDir, `${category || 'text'}_${sanitized}.wav`);
        log(`[genTokenAudio] cache check for "${token}" → ${cachedFile}`);
        if (fs.existsSync(cachedFile)) {
            log(`[genTokenAudio] cache HIT for "${token}", returning ${cachedFile}`);
            return cachedFile;
        }
        // generate and save to the cache
        log(`[genTokenAudio] cache MISS for "${token}", generating new TTS`);
        const { pythonPath: pythonExe, scriptPath, language, modelId, sampleRate } = sileroConfig;
        const baseCategory = category?.split('_')[0];
        const speakerName =
            opts?.speaker
            ?? (baseCategory && categoryVoiceMap[baseCategory])
            ?? sileroConfig.defaultSpeaker!;
        // Send text to long-running Silero server instead of spawning
        const res = await fetch('http://localhost:5002/tts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text: token,
                speaker: speakerName,
                sample_rate: sampleRate,
            }),
            dispatcher: keepAliveAgent
        });
        if (!res.ok) {
            // Capture and log the error body for debugging
            let errorBody: string;
            try {
                errorBody = await res.text();
            } catch {
                errorBody = '<unable to read response body>';
            }
            log(
                `[genTokenAudio] TTS server error ${res.status} ${res.statusText}: ${errorBody}`
            );
            throw new Error(`TTS server error: ${res.status} ${res.statusText}`);
        }
        const wavBuffer = Buffer.from(await res.arrayBuffer());
        fs.writeFileSync(cachedFile, wavBuffer);
        return cachedFile;
    }

    // 1) Earcon?
    const wav = findTokenSound(token);
    log(`[getTokenSound] token="${token}", earconDir="${config.earconPath()}"`);
    if (wav) return wav;

    // 2) Skip blanks
    if (!token.trim()) throw new Error('No text to TTS for token');

    // 3) Determine which Silero speaker to use
    const baseCategory = category?.split('_')[0];
    const speakerName =
        opts?.speaker
        ?? (baseCategory && categoryVoiceMap[baseCategory])
        ?? sileroConfig.defaultSpeaker!;

    // 4) Validate & build outFile as before…
    const { pythonPath: pythonExe, scriptPath, language, modelId, sampleRate } = sileroConfig;
    if (!fs.existsSync(pythonExe)) throw new Error(`Python not found: ${pythonExe}`);
    if (!fs.existsSync(scriptPath)) throw new Error(`Silero script not found: ${scriptPath}`);

    const tmpDir = path.join(os.tmpdir(), 'lipcoder_silero_tts');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const outFile = path.join(tmpDir, `tts_${Date.now()}_${Math.random().toString(36).slice(2)}.wav`);

    const args = [
        scriptPath,
        '--language', language,
        '--model_id', modelId,
        '--speaker', speakerName,
        '--text', token,
        '--sample_rate', String(sampleRate),
        '--output', outFile,
    ];

    const proc = spawn(pythonExe, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr?.on('data', c => stderr += c.toString());

    await new Promise<void>((resolve, reject) => {
        proc.on('error', reject);
        proc.on('close', code => {
            if (code !== 0) return reject(new Error(
                `Silero exited ${code}\nCmd: ${pythonExe} ${args.join(' ')}\n${stderr}`
            ));
            resolve();
        });
    });

    log(`[genTokenAudio] generated new TTS to ${outFile}`);
    return outFile;
}


export const earconRaw: Record<string, Buffer> = {};

export function playEarcon(token: string): Promise<void> {
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
    // Parse header fields: channels @22, sampleRate @24, bitDepth @34
    const channels = buf.readUInt16LE(22);
    const sampleRate = buf.readUInt32LE(24);
    const bitDepth = buf.readUInt16LE(34);
    // Locate the "data" subchunk (skipping any extra chunks) and slice out PCM
    const dataIdx = buf.indexOf(Buffer.from('data'));
    if (dataIdx < 0) throw new Error(`No data chunk in earcon ${file}`);
    const pcm = buf.slice(dataIdx + 8);
    // Include signed/float flags for Speaker
    const fmt = { channels, sampleRate, bitDepth, signed: true, float: false };


    return new Promise((resolve) => {
        try {
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
            speaker.write(pcm);
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


// ── Speak a token (generate + play) ───────────────────────────────────────────
export async function speakToken(
    token: string,
    category?: string,
    opts?: { speaker?: string }
): Promise<void> {
    try {
        log(`[speakTokenList] token="${token}" category="${category}"`);
        if (isAlphabet(token)) {
            const lower = token.toLowerCase();
            const alphaPath = path.join(config.alphabetPath(), `${lower}.wav`);
            if (fs.existsSync(alphaPath)) {
                return await playCachedWav(alphaPath);
            }
        } else if (isNumber(token)) {
            const numPath = path.join(config.numberPath(), `${token}.wav`);
            if (fs.existsSync(numPath)) {
                return await playCachedWav(numPath);
            }
        } else if (isEarcon(token)) {
            return await playEarcon(token);
        }

        console.log('[speakToken] token=', JSON.stringify(token), 'category=', category);
        // existing fallback TTS logic...
        const baseCategory = category?.split('_')[0];
        const speakerName =
            opts?.speaker
            ?? (baseCategory && categoryVoiceMap[baseCategory])
            ?? sileroConfig.defaultSpeaker!;
        const filePath = await genTokenAudio(token, category, { speaker: speakerName });
        return await playWave(filePath);
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
            await speakToken(token, category);
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
    if (opts?.immediate) {
        const p = playImmediate(filePath);
        playQueue = p.catch(() => { });
        return p;
    }
    // Quick fallback for WAVs with a JUNK chunk to avoid wav.Reader errors/delay
    try {
        const fd = fs.openSync(filePath, 'r');
        const junkBuf = Buffer.alloc(4);
        // Read bytes at offset 12 (chunk ID of first subchunk)
        fs.readSync(fd, junkBuf, 0, 4, 12);
        fs.closeSync(fd);
        if (junkBuf.toString('ascii') === 'JUNK') {
            log(`[playWave] Detected JUNK chunk in ${filePath}, playing via raw earcon playback`);
            // Find the token corresponding to this earcon file
            const fname = path.basename(filePath);
            let tokenFound: string | undefined;
            for (const t of earconTokens) {
                const p = getTokenSound(t);
                if (p && path.basename(p) === fname) {
                    tokenFound = t;
                    break;
                }
            }
            if (tokenFound) {
                return playEarcon(tokenFound);
            }
            // Fallback to wav.Reader if not a known earcon
        }
    } catch {
        // ignore, proceed as normal
    }
    // 1) If this is an earcon, bypass wav.Reader completely
    if (opts?.isEarcon) {
        log(`[playWave] Playing earcon via raw PCM cache: ${filePath}`);
        // Determine token and use playEarcon
        const fname = path.basename(filePath);
        let tokenFound: string | undefined;
        for (const t of earconTokens) {
            const p = getTokenSound(t);
            if (p && path.basename(p) === fname) {
                tokenFound = t;
                break;
            }
        }
        if (tokenFound) {
            return playEarcon(tokenFound);
        }
        // Fallback to wav.Reader if not found
    }

    // 2) Otherwise, your existing wav.Reader → Speaker logic…
    playQueue = playQueue.then(() => doPlay(filePath, opts));
    return playQueue;
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
        const buf = fs.readFileSync(filePath);

        // Header offsets: channels @22 (UInt16LE), sampleRate @24 (UInt32LE), bitsPerSample @34 (UInt16LE)
        const channels = buf.readUInt16LE(22);
        const sampleRate = buf.readUInt32LE(24);
        const bitDepth = buf.readUInt16LE(34);

        // Find the “data” tag, then skip the next 4 bytes (size) to get to PCM data
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