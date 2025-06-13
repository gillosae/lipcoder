// client/src/audio.ts

import * as fs from 'fs';
import * as path from 'path';
import Speaker from 'speaker';
import * as wav from 'wav';
import { spawn, ChildProcess } from 'child_process';
import * as os from 'os';
import { Readable } from 'stream';
import { lipcoderLog } from './logger';
import { specialCharMap } from './mapping';

let currentSpeaker: Speaker | null = null;
let currentFallback: ChildProcess | null = null;

function hookChildErrors(cp: ChildProcess) {
    cp.on('error', err => {
        lipcoderLog.appendLine(`🔊 player “error” event: ${err.stack || err}`);
    });
    if (cp.stderr) {
        cp.stderr.on('data', chunk => {
            lipcoderLog.appendLine(`🔊 player stderr: ${chunk.toString().trim()}`);
        });
    }
    return cp;
}

// ── Preload Earcons into Memory ──────────────────────────────────────────────
// List every token that uses a WAV earcon:
const earconTokens = [
    ' ', "'", '"',
    '{', '}', '<', '>', '[', ']', '(', ')',
    ',', ';', '/', '.', '-', ':', //'_', 
];

// Cache for each token: { format, pcmBuffer }
interface EarconData { format: any; pcm: Buffer }
const earconCache: Record<string, EarconData> = {};

// Cache for special-word TTS audio (format + PCM)
export const specialWordCache: Record<string, EarconData> = {};
/** Decode each special-word TTS once and stash in memory */
export async function preloadSpecialWords() {
    const cacheDir = path.join(os.tmpdir(), 'lipcoder_tts_cache');
    const words = Object.values(specialCharMap);
    const concurrency = 5;
    lipcoderLog.appendLine(`[preloadSpecialWords] Starting preload of ${words.length} words with concurrency=${concurrency}`);
    const startTotal = Date.now();

    let idx = 0;
    async function worker() {
        while (true) {
            const word = words[idx++];
            if (!word) break;
            const t0 = Date.now();
            const sanitized = word.toLowerCase().replace(/[^a-z0-9]+/g, '_');
            const file = path.join(cacheDir, `text_${sanitized}.wav`);
            await new Promise<void>((resolve, reject) => {
                const reader = new wav.Reader();
                const bufs: Buffer[] = [];
                let fmt: any;
                reader.on('format', f => { fmt = f; });
                reader.on('data', d => bufs.push(d));
                reader.on('end', () => {
                    specialWordCache[word] = { format: fmt, pcm: Buffer.concat(bufs) };
                    resolve();
                });
                reader.on('error', reject);
                fs.createReadStream(file).pipe(reader);
            });
            const elapsed = Date.now() - t0;
            lipcoderLog.appendLine(`[preloadSpecialWords] Loaded "${word}" in ${elapsed}ms`);
        }
    }

    // Kick off workers
    const workers = Array.from({ length: concurrency }, () => worker());
    await Promise.all(workers);

    const totalElapsed = Date.now() - startTotal;
    lipcoderLog.appendLine(`[preloadSpecialWords] Completed loading all words in ${totalElapsed}ms`);
}
/** Play a preloaded special-word from memory */
export function playSpecial(word: string): Promise<void> {
    lipcoderLog.appendLine(`[playSpecial] word="${word}" cached=${!!specialWordCache[word]}`);
    const entry = specialWordCache[word];
    if (!entry) {
        // fallback to file-based playback
        lipcoderLog.appendLine(`[playSpecial] fallback to file-based playback for "${word}"`);
        const cacheDir = path.join(os.tmpdir(), 'lipcoder_tts_cache');
        const sanitized = word.toLowerCase().replace(/[^a-z0-9]+/g, '_');
        const file = path.join(cacheDir, `text_${sanitized}.wav`);
        lipcoderLog.appendLine(`[DEBUG playSpecial] fallback file=${file}, exists=${fs.existsSync(file)}`);
        return playWave(file);
    }
    return new Promise((resolve, reject) => {
        const speaker = new Speaker(entry.format);
        speaker.on('error', reject);
        speaker.on('close', resolve);
        speaker.write(entry.pcm);
        speaker.end();
    });
}

/** Decode every earcon WAV once and stash its PCM + format. */
// export async function preloadEarcons() {
//     lipcoderLog.appendLine("Start preloadEarcons");
//     await Promise.all(earconTokens.map(token => {
//         const file = getTokenSound(token);
//         console.log(file);
//         if (!file) {
//             console.log(`no "${file}`);
//             return Promise.resolve();
//         }
//         return new Promise<void>((resolve, reject) => {
//             const reader = new wav.Reader();
//             const bufs: Buffer[] = [];
//             let fmt: any;

//             reader.on('format', f => { fmt = f; });
//             reader.on('data', d => bufs.push(d));
//             reader.on('end', () => {
//                 earconCache[token] = { format: fmt, pcm: Buffer.concat(bufs) };
//                 resolve();
//             });
//             reader.on('error', reject);

//             fs.createReadStream(file).pipe(reader);
//         });
//     }));
// }
export async function preloadEarcons() {
    lipcoderLog.appendLine("Start preloadEarcons (raw buffers)");
    const start = Date.now();
    for (const token of earconTokens) {
        const file = getTokenSound(token);
        if (!file) {
            console.log(`no "${file}`);
            return Promise.resolve();
        }
        try {
            const buf = fs.readFileSync(file);
            earconRaw[token] = buf;
            lipcoderLog.appendLine(`  loaded "${token}" (${buf.length} bytes)`);
        } catch (e) {
            lipcoderLog.appendLine(`  failed to load "${token}": ${e}`);
        }
    }
    const total = Date.now() - start;
    lipcoderLog.appendLine(`ALL earcons loaded in ${total}ms`);
}


// ── TTS Backends & Config ─────────────────────────────────────────────────────
export enum TTSBackend {
    Silero = 'silero',
    Espeak = 'espeak',
}

export interface SileroConfig {
    pythonExe: string;
    scriptPath: string;
    language: string;
    modelId: string;
    defaultSpeaker?: string;
    sampleRate: number;
    // gap?: number; /** silence padding between chunks (ms) */
    // speed?: number; /** playback speed (higher = faster) */
}

let currentBackend = TTSBackend.Silero;
let sileroConfig: SileroConfig = {
    pythonExe: '',
    scriptPath: '',
    language: 'en',
    modelId: 'v3_en',
    defaultSpeaker: 'en_3',
    sampleRate: 24000,
};


// ── Category → voice mapping ──────────────────────────────────────────────────
const categoryVoiceMap: Record<string, string> = {
    keyword: 'en_1',
    type: 'en_2',
    literal: 'en_4',
    variable: 'en_5',
    operator: 'en_6',
    comment: 'en_7',
};


// ── Earcon directory & setup ──────────────────────────────────────────────────
let audioDir = path.join(__dirname, 'audio', 'earcon');
const earconDir = path.join(audioDir, 'earcon');
export function setAudioDirectory(dir: string) {
    audioDir = dir;
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
    lipcoderLog.appendLine(`[genTokenAudio] START token="${token}" category="${category}"`);
    lipcoderLog.appendLine(`[DEBUG genTokenAudio] audioDir="${audioDir}"`);

    // 0) Pre-generated keyword audio?
    if (category && category.startsWith('keyword_')) {
        const lang = category.split('_')[1];      // “python” or “typescript”
        const filename = token.toLowerCase();     // match your saved filenames
        const filePath = path.join(audioDir, lang, `${filename}.wav`);
        lipcoderLog.appendLine(`[DEBUG genTokenAudio] looking up keyword WAV at ${filePath}, exists=${fs.existsSync(filePath)}`);
        if (fs.existsSync(filePath)) {
            lipcoderLog.appendLine(`[genTokenAudio] keyword bypass: using pre-generated audio at ${filePath}`);
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
        lipcoderLog.appendLine(`[genTokenAudio] cache check for "${token}" → ${cachedFile}`);
        if (fs.existsSync(cachedFile)) {
            lipcoderLog.appendLine(`[genTokenAudio] cache HIT for "${token}", returning ${cachedFile}`);
            return cachedFile;
        }
        // generate and save to the cache
        lipcoderLog.appendLine(`[genTokenAudio] cache MISS for "${token}", generating new TTS`);
        const { pythonExe, scriptPath, language, modelId, sampleRate } = sileroConfig;
        const speakerName =
            opts?.speaker
            ?? (category && categoryVoiceMap[category])
            ?? sileroConfig.defaultSpeaker!;
        const args = [
            scriptPath,
            '--language', language,
            '--model_id', modelId,
            '--speaker', speakerName,
            '--text', token,
            '--sample_rate', String(sampleRate),
            '--output', cachedFile,
        ];
        await new Promise<void>((resolve, reject) => {
            const proc = spawn(pythonExe, args, { stdio: ['ignore', 'pipe', 'pipe'] });
            let stderr = '';
            proc.stderr?.on('data', c => stderr += c.toString());
            proc.on('error', reject);
            proc.on('close', code => {
                if (code !== 0) reject(new Error(`Silero exited ${code}\n${stderr}`));
                else resolve();
            });
        });
        lipcoderLog.appendLine(`[genTokenAudio] generated new TTS to ${cachedFile}`);
        return cachedFile;
    }

    // 1) Earcon?
    const wav = getTokenSound(token);
    lipcoderLog.appendLine(`[DEBUG getTokenSound] token="${token}", audioDir="${audioDir}"`);
    if (wav) return wav;

    // 2) Skip blanks
    if (!token.trim()) throw new Error('No text to TTS for token');

    // 3) Determine which Silero speaker to use
    const speakerName =
        opts?.speaker
        ?? (category && categoryVoiceMap[category])
        ?? sileroConfig.defaultSpeaker!;

    // 4) Validate & build outFile as before…
    const { pythonExe, scriptPath, language, modelId, sampleRate } = sileroConfig;
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

    lipcoderLog.appendLine(`[genTokenAudio] generated new TTS to ${outFile}`);
    return outFile;
}

// ── Earcon lookup ─────────────────────────────────────────────────────────────
function getTokenSound(token: string): string | null {
    if (token === ' ') {
        return path.join(earconDir, 'space.wav');
    }
    if (getTokenSound.singleQuote === undefined) {
        getTokenSound.singleQuote = true;
        getTokenSound.doubleQuote = true;
    }
    if (token === "'") {
        const file = getTokenSound.singleQuote ? 'quote.wav' : 'quote2.wav';
        getTokenSound.singleQuote = !getTokenSound.singleQuote;
        return path.join(earconDir, file);
    }
    if (token === '"') {
        const file = getTokenSound.doubleQuote ? 'bigquote.wav' : 'bigquote2.wav';
        getTokenSound.doubleQuote = !getTokenSound.doubleQuote;
        return path.join(earconDir, file);
    }
    const map: Record<string, string> = {
        '{': 'brace.wav', '}': 'brace2.wav',
        '<': 'anglebracket.wav', '>': 'anglebracket2.wav',
        '[': 'squarebracket.wav', ']': 'squarebracket2.wav',
        '(': 'parenthesis.wav', ')': 'parenthesis2.wav',
        ',': 'comma.wav', ';': 'semicolon.wav',
        '/': 'slash.wav', // '_': 'underbar.wav',
        '.': 'dot.wav', ':': 'colon.wav', '-': 'bar.wav',
    };
    if (map[token]) {
        return path.join(earconDir, map[token]);
    }
    return null;
}
namespace getTokenSound {
    export let singleQuote: boolean;
    export let doubleQuote: boolean;
}


const earconRaw: Record<string, Buffer> = {};
export function playEarcon(token: string): Promise<void> {
    const file = getTokenSound(token);
    if (!file) {
        // no earcon mapped
        return Promise.resolve();
    }

    // lazy-load the raw file once
    if (!earconRaw[token]) {
        earconRaw[token] = fs.readFileSync(file);
    }
    const buf = earconRaw[token];

    // assume 44-byte header, then PCM16LE mono at sileroConfig.sampleRate
    const pcm = buf.slice(44);
    const fmt = {
        channels: 1,
        bitDepth: 16,
        sampleRate: sileroConfig.sampleRate,
    };

    return new Promise((resolve, reject) => {
        const speaker = new Speaker(fmt);
        speaker.on('error', reject);
        speaker.on('close', resolve);
        speaker.write(pcm);
        speaker.end();
    });
}

// ── Helpers ──────────────────────────────────────────────────────────────────
/** Returns true if we have a WAV earcon for this single-character token */
function isEarcon(token: string): boolean {
    return getTokenSound(token) !== null;
}

// ── Speak a token (generate + play) ───────────────────────────────────────────
export async function speakToken(
    token: string,
    category?: string,
    opts?: { speaker?: string }
): Promise<void> {
    console.log('[speakToken] token=', JSON.stringify(token), 'category=', category);
    // Earcon?
    if (isEarcon(token)) {
        return playEarcon(token);
    }
    // Skip blank
    if (!token.trim()) {
        return;
    }
    // Choose voice
    const speakerName =
        opts?.speaker
        ?? (category && categoryVoiceMap[category])
        ?? sileroConfig.defaultSpeaker!;

    // Generate async file, then play it
    const filePath = await genTokenAudio(token, speakerName);
    return playWave(filePath);
}



// ── eSpeak TTS ─────────────────────────────────────────────────────────────────
function speakWithEspeak(
    text: string,
    opts?: { voice?: string; pitch?: number; gap?: number; speed?: number }
): Promise<void> {
    const safeText = text.replace(/"/g, '\\"');
    const args: string[] = ['-v', opts?.voice ?? 'en-us'];
    if (opts?.pitch !== undefined) {
        args.push('-p', String(opts.pitch));
    }
    args.push('-g', String(opts?.gap ?? 0));
    args.push('-s', String(opts?.speed ?? 250));
    args.push(safeText);

    return new Promise((resolve, reject) => {
        const proc = spawn('espeak', args, { stdio: 'ignore' });
        proc.on('error', reject);
        proc.on('close', code => code === 0 ? resolve() : reject(new Error(`espeak ${code}`)));
    });
}

// ── Silero TTS (Hub-only) ──────────────────────────────────────────────────────
function speakWithSilero(
    text: string,
    opts?: { speakerName?: string }
): Promise<void> {
    // guard again in the Silero-specific layer
    if (!text.trim()) {
        return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
        const { pythonExe, scriptPath, language, modelId, defaultSpeaker, sampleRate } = sileroConfig;

        // debug: log what we’re about to run
        console.log('[Silero] running:',
            pythonExe,
            scriptPath,
            '--language', language,
            '--model_id', modelId,
            '--speaker', (opts?.speakerName ?? defaultSpeaker),
            '--text', text,
            '--sample_rate', sampleRate
        );

        if (!fs.existsSync(pythonExe)) {
            return reject(new Error(`Python not found: ${pythonExe}`));
        }
        if (!fs.existsSync(scriptPath)) {
            return reject(new Error(`Silero script not found: ${scriptPath}`));
        }

        const tmpDir = path.join(os.tmpdir(), 'lipcoder_silero_tts');
        if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
        const outFile = path.join(tmpDir, `tts_${Date.now()}.wav`);

        const args = [
            scriptPath,
            '--language', language,
            '--model_id', modelId,
            '--speaker', opts?.speakerName ?? defaultSpeaker!,
            '--text', text,
            '--sample_rate', String(sampleRate),
            // '--gap', String(sileroConfig.gap ?? 0),
            // '--speed', String(sileroConfig.speed ?? 250),
            '--output', outFile,
        ];

        const proc = spawn(pythonExe, args, { stdio: ['ignore', 'pipe', 'pipe'] });

        let stderr = '';
        proc.stderr?.on('data', chunk => {
            stderr += chunk.toString();
        });

        proc.on('error', e => reject(e));

        proc.on('close', async code => {
            if (code !== 0) {
                return reject(new Error(
                    `Silero exited ${code}\n` +
                    `Command: ${pythonExe} ${args.join(' ')}\n` +
                    `Error output:\n${stderr}`
                ));
            }
            try {
                await playWave(outFile);
                resolve();
            } catch (e) {
                reject(e);
            }
        });
    });
}

// ── Play a WAV file by streaming its PCM to the speaker, avoiding any external process spawns. ──────────
let playQueue = Promise.resolve();

export function playWave(
    filePath: string,
    opts?: { isEarcon?: boolean; rate?: number }
): Promise<void> {
    // 1) If this is an earcon, bypass wav.Reader completely
    if (opts?.isEarcon) {
        let cmd: string, args: string[];
        if (process.platform === 'darwin') {
            cmd = 'afplay';
            args = [filePath];
        } else if (process.platform === 'win32') {
            cmd = 'powershell';
            args = ['-c', `(New-Object Media.SoundPlayer '${filePath}').PlaySync();`];
        } else if (process.platform === 'linux') {
            cmd = 'play';
            args = [filePath];
        } else {
            cmd = 'aplay';
            args = [filePath];
        }

        // spawn and return that process
        const cp = hookChildErrors(spawn(cmd, args, { stdio: 'ignore' }));
        return new Promise((resolve, reject) => {
            currentFallback = cp;
            cp.on('close', code => {
                currentFallback = null;
                if (code === 0 || code === null) resolve();
                else reject(new Error(`fallback player ${code}`));
            });
        });
    }

    // 2) Otherwise, your existing wav.Reader → Speaker logic…
    playQueue = playQueue.then(() => new Promise<void>((resolve, reject) => {
        const fileStream = fs.createReadStream(filePath);
        const reader = new wav.Reader();

        let fallback = false;
        function doFallback(err: any) {
            lipcoderLog.appendLine(`🛑 wav-stream error: ${err.stack || err}`);

            if (fallback) return;
            fallback = true;

            // Clean up the failed stream
            reader.removeAllListeners();
            fileStream.unpipe(reader);
            fileStream.destroy();

            let cmd: string, args: string[];
            if (process.platform === 'darwin') {
                // Use built-in afplay on macOS
                cmd = 'afplay';
                args = [filePath];
            } else if (process.platform === 'win32') {
                // Use PowerShell SoundPlayer on Windows
                cmd = 'powershell';
                args = ['-c', `(New-Object Media.SoundPlayer '${filePath}').PlaySync();`];
            } else if (process.platform === 'linux') {
                // Prefer `play` (SoX) on Linux if installed
                cmd = 'play';
                args = [filePath];
            } else {
                // Fallback to aplay
                cmd = 'aplay';
                args = [filePath];
            }
            const p = hookChildErrors(spawn(cmd, args, { stdio: 'ignore' }));
            currentFallback = p;

            p.on('close', (code) => {
                // always clear the tracked process
                currentFallback = null;

                // code === 0  → normal finish
                // code === null → was killed by stopPlayback()
                if (code === 0 || code === null) {
                    resolve();
                } else {
                    reject(new Error(`fallback player ${code}`));
                }
            });
        }

        reader.on('format', (format: any) => {
            lipcoderLog.appendLine(`🔊 got format: ${JSON.stringify(format)}`);
            try {
                const isEarcon = opts?.isEarcon ?? false;
                const adjustedFormat = { ...format };

                // Speed up earcons by increasing sampleRate
                if (isEarcon) {
                    adjustedFormat.sampleRate = Math.floor(format.sampleRate * 2.4);
                }

                // ── Abort any previous playback ──────────────────────────────
                if (currentSpeaker) { try { currentSpeaker.end() } catch { }; currentSpeaker = null; }
                if (currentFallback) { try { currentFallback.kill() } catch { }; currentFallback = null; }
                // ── Now start the new speaker instance ───────────────────────
                const speaker = new Speaker(adjustedFormat);
                currentSpeaker = speaker;

                reader.pipe(speaker);
                speaker.on('close', resolve);
                speaker.on('error', err => {
                    // Log speaker-level errors
                    lipcoderLog.appendLine(`🛑 Speaker error: ${err.stack || err}`);
                    reject(err);
                });
            } catch (err) {
                doFallback(err);
            }
        });

        reader.on('error', doFallback);
        fileStream.on('error', doFallback);
        fileStream.pipe(reader);
    }));

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
        try { currentSpeaker.end(); } catch { }
        currentSpeaker = null;
    }
    if (currentFallback) {
        try { currentFallback.kill(); } catch { }
        currentFallback = null;
    }
}