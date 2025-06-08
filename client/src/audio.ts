// client/src/audio.ts

import Speaker from 'speaker';
import { Readable } from 'stream';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as wav from 'wav';


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
    defaultSpeaker: 'en_2',
    sampleRate: 24000,
};


// ── Category → voice mapping ──────────────────────────────────────────────────
const categoryVoiceMap: Record<string, string> = {
    keyword: 'en_0',
    type: 'en_1',
    literal: 'en_2',
    variable: 'en_3',
    operator: 'en_4',
    comment: 'en_5',
};

// ── Earcon directory & setup ──────────────────────────────────────────────────
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

// ── Generate (but don’t play) audio for a token ───────────────────────────────
// client/src/audio.ts
export async function genTokenAudio(
    token: string,
    category?: string,
    opts?: { speaker?: string }
): Promise<string> {
    // 1) Earcon?
    const wav = getTokenSound(token);
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

    return outFile;
}

// ── Speak a token (generate + play) ───────────────────────────────────────────
export async function speakToken(
    token: string,
    category?: string,
    opts?: { speaker?: string }
): Promise<void> {
    // Earcon?
    const wav = getTokenSound(token);
    if (wav) {
        return playWave(wav);
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

// ── Earcon lookup ─────────────────────────────────────────────────────────────
function getTokenSound(token: string): string | null {
    if (token === ' ') {
        return path.join(audioDir, 'space.wav');
    }
    if (getTokenSound.singleQuote === undefined) {
        getTokenSound.singleQuote = true;
        getTokenSound.doubleQuote = true;
    }
    if (token === "'") {
        const file = getTokenSound.singleQuote ? 'quote.wav' : 'quote2.wav';
        getTokenSound.singleQuote = !getTokenSound.singleQuote;
        return path.join(audioDir, file);
    }
    if (token === '"') {
        const file = getTokenSound.doubleQuote ? 'bigquote.wav' : 'bigquote2.wav';
        getTokenSound.doubleQuote = !getTokenSound.doubleQuote;
        return path.join(audioDir, file);
    }
    const map: Record<string, string> = {
        '{': 'brace.wav', '}': 'brace2.wav',
        '<': 'anglebracket.wav', '>': 'anglebracket2.wav',
        '[': 'squarebracket.wav', ']': 'squarebracket2.wav',
        '(': 'parenthesis.wav', ')': 'parenthesis2.wav',
        ',': 'comma.wav', ';': 'semicolon.wav',
        '/': 'slash.wav', '_': 'underbar.wav',
        '.': 'dot.wav', ':': 'colon.wav', '-': 'bar.wav',
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
export function playWave(filePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const fileStream = fs.createReadStream(filePath);
        const reader = new wav.Reader();

        let fallback = false;
        function doFallback(err: any) {
            if (fallback) return;
            fallback = true;
            // cleanup
            reader.removeAllListeners();
            fileStream.unpipe(reader);
            fileStream.destroy();

            // spawn external player as before
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
            p.on('close', code => code === 0 ? resolve() : reject(new Error(`fallback player ${code}`)));
        }

        // Primary path: in-process streaming
        reader.on('format', (format: any) => {
            try {
                const speaker = new Speaker(format);
                reader.pipe(speaker);
                speaker.on('close', resolve);
                speaker.on('error', reject);
            } catch (err) {
                doFallback(err);
            }
        });

        reader.on('error', doFallback);
        fileStream.on('error', doFallback);
        fileStream.pipe(reader);
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