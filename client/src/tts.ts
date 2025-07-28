import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { fetch, Agent } from 'undici';
import { log } from './utils';
import { config, categoryVoiceMap, sileroConfig } from './config';
import { isAlphabet, isNumber } from './mapping';

// Keep-alive agent for HTTP fetch to reuse connections
const keepAliveAgent = new Agent({ keepAliveTimeout: 60000 });

// Cache for special-word TTS audio (format + PCM)
export const specialWordCache: Record<string, { format: any; pcm: Buffer }> = {};

/**
 * Generate (but don't play) audio for a token
 */
export async function genTokenAudio(
    token: string,
    category?: string,
    opts?: { speaker?: string }
): Promise<string> {
    log(`[genTokenAudio] START token="${token}" category="${category}"`);

    // 0) Pre-generated keyword audio?
    if (category && category.startsWith('keyword_')) {
        const lang = category.split('_')[1];      // "python" or "typescript"
        const filename = token.toLowerCase();     // match your saved filenames
        const filePath = path.join(config.earconPath(), lang, `${filename}.pcm`);
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
        const cachedFile = path.join(cacheDir, `${category || 'text'}_${sanitized}.pcm`);
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
        
        // Convert mono WAV to stereo PCM for consistency with other audio files
        try {
            // For now, save as WAV but with PCM extension for identification
            // TODO: Consider converting to actual stereo PCM format
            fs.writeFileSync(cachedFile, wavBuffer);
            return cachedFile;
        } catch (err) {
            log(`[genTokenAudio] Error saving TTS cache: ${err}`);
            throw err;
        }
    }

    // 1) Skip blanks
    if (!token.trim()) throw new Error('No text to TTS for token');

    // 2) Determine which Silero speaker to use
    const baseCategory = category?.split('_')[0];
    const speakerName =
        opts?.speaker
        ?? (baseCategory && categoryVoiceMap[baseCategory])
        ?? sileroConfig.defaultSpeaker!;

    // 3) Validate & build outFile as before…
    const { pythonPath: pythonExe, scriptPath, language, modelId, sampleRate } = sileroConfig;
    if (!fs.existsSync(pythonExe)) throw new Error(`Python not found: ${pythonExe}`);
    if (!fs.existsSync(scriptPath)) throw new Error(`Silero script not found: ${scriptPath}`);

    const tmpDir = path.join(os.tmpdir(), 'lipcoder_silero_tts');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
            const outFile = path.join(tmpDir, `tts_${Date.now()}_${Math.random().toString(36).slice(2)}.pcm`);

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

/**
 * Play a preloaded special-word from memory
 */
export function playSpecial(word: string): Promise<void> {
    log(`[playSpecial] word="${word}" cached=${!!specialWordCache[word]}`);
    const entry = specialWordCache[word];
    if (!entry) {
        // fallback to file-based playback
        log(`[playSpecial] fallback to file-based playback for "${word}"`);
        const cacheDir = path.join(os.tmpdir(), 'lipcoder_tts_cache');
        const sanitized = word.toLowerCase().replace(/[^a-z0-9]+/g, '_');
        const file = path.join(cacheDir, `text_${sanitized}.pcm`);
        log(`[playSpecial] fallback file=${file}, exists=${fs.existsSync(file)}`);
        return Promise.resolve(); // This will be handled by the main audio module
    }
    return new Promise((resolve, reject) => {
        const Speaker = require('speaker');
        const speaker = new Speaker(entry.format);
        speaker.on('error', reject);
        speaker.on('close', resolve);
        speaker.write(entry.pcm);
        speaker.end();
    });
}

/**
 * Check if a token should use TTS (not an earcon)
 */
export function isTTSRequired(token: string): boolean {
    return !isAlphabet(token) && !isNumber(token) && token.trim().length > 0;
}

/**
 * Get the appropriate speaker name for a token category
 */
export function getSpeakerForCategory(category?: string, opts?: { speaker?: string }): string {
    const baseCategory = category?.split('_')[0];
    return opts?.speaker
        ?? (baseCategory && categoryVoiceMap[baseCategory])
        ?? sileroConfig.defaultSpeaker!;
} 