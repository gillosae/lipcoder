// client/src/audio.ts

import Speaker from 'speaker';
import { Readable } from 'stream';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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
}

let currentBackend = TTSBackend.Silero;
let sileroConfig: SileroConfig = {
    pythonExe: '',
    scriptPath: '',
    language: 'en',
    modelId: 'v3_en',
    defaultSpeaker: 'en_2',
    sampleRate: 24000,
};

/**
 * Map LSP token categories to distinct Silero speaker IDs
 * (this emulates “coloring” in audio form)
 */
const categoryVoiceMap: Record<string, string> = {
    keyword: 'en_0',
    type: 'en_1',
    literal: 'en_2',
    variable: 'en_3',
    operator: 'en_4',
    comment: 'en_5',
};

// ── Audio directory for earcons (set by extension.ts) ─────────────────────────
let audioDir = path.join(__dirname, 'audio');
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

// ── Speak a single token (earcon or TTS) ──────────────────────────────────────
export async function speakToken(
    token: string,
    category?: string,
    opts?: { speaker?: string }
): Promise<void> {
    // 1) Play earcon if it exists
    const wav = getTokenSound(token);
    if (wav) {
        return playWave(wav);
    }

    // 2) **Don’t call Silero on empty or whitespace-only text**
    if (!token.trim()) {
        return;
    }

    // 3) Pick your speaker
    const speakerName =
        opts?.speaker
        ?? (category && categoryVoiceMap[category])
        ?? sileroConfig.defaultSpeaker;

    // 4) Speak via Silero
    return speak(token, { speakerName });
}

// ── Determine earcon path or null for TTS ─────────────────────────────────────
function getTokenSound(token: string): string | null {
    // SPACE
    if (token === ' ') {
        return path.join(audioDir, 'space.wav');
    }

    // initialize toggle states on first call
    if (getTokenSound.singleQuote === undefined) {
        getTokenSound.singleQuote = true;
        getTokenSound.doubleQuote = true;
    }

    // SINGLE QUOTE
    if (token === "'") {
        const file = getTokenSound.singleQuote ? 'quote.wav' : 'quote2.wav';
        getTokenSound.singleQuote = !getTokenSound.singleQuote;
        return path.join(audioDir, file);
    }

    // DOUBLE QUOTE
    if (token === '"') {
        const file = getTokenSound.doubleQuote ? 'bigquote.wav' : 'bigquote2.wav';
        getTokenSound.doubleQuote = !getTokenSound.doubleQuote;
        return path.join(audioDir, file);
    }

    // OTHER PUNCTUATION
    const map: Record<string, string> = {
        '{': 'brace.wav', '}': 'brace2.wav',
        '<': 'anglebracket.wav', '>': 'anglebracket2.wav',
        '[': 'squarebracket.wav', ']': 'squarebracket2.wav',
        '(': 'parenthesis.wav', ')': 'parenthesis2.wav',
        ',': 'comma.wav', ';': 'semicolon.wav',
        '/': 'slash.wav', '_': 'underbar.wav',
        '.': 'dot.wav',               // ← catch single‐dot here
        ':': 'column.wav',            // ← colon
        '-': 'bar.wav',               // ← hyphen/minus
    };
    if (map[token]) {
        return path.join(audioDir, map[token]);
    }

    return null;
}
namespace getTokenSound {
    export let singleQuote: boolean;
    export let doubleQuote: boolean;
}

// ── Generic TTS entrypoint ────────────────────────────────────────────────────
export function speak(
    text: string,
    opts?: {
        speakerName?: string;
        voice?: string;
        pitch?: number;
        gap?: number;
        speed?: number;
    }
): Promise<void> {
    switch (currentBackend) {
        case TTSBackend.Silero:
            return speakWithSilero(text, opts);
        default:
            return speakWithEspeak(text, opts);
    }
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
        proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`espeak ${code}`))));
    });
}

// ── Play a WAV file via native player ─────────────────────────────────────────
function playWave(filePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        let cmd: string, args: string[];
        if (process.platform === 'darwin') {
            cmd = 'afplay'; args = [filePath];
        } else if (process.platform === 'win32') {
            cmd = 'powershell';
            args = ['-c', `(New-Object Media.SoundPlayer '${filePath}').PlaySync();`];
        } else {
            cmd = 'aplay'; args = [filePath];
        }
        const p = spawn(cmd, args, { stdio: 'ignore' });
        p.on('error', reject);
        p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`player ${code}`))));
    });
}

// ── Tone generator (unused) ───────────────────────────────────────────────────
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