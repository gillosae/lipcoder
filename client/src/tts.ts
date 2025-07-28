import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { fetch, Agent } from 'undici';
import { log } from './utils';
import { config, categoryVoiceMap, sileroConfig } from './config';
import { isAlphabet, isNumber } from './mapping';
import { serverManager } from './server_manager';

// Keep-alive agent for HTTP fetch to reuse connections
const keepAliveAgent = new Agent({ keepAliveTimeout: 60000 });

// Note: specialWordCache removed - now using direct TTS inference

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

    // 0.5) For special characters, skip caching and always generate fresh TTS
    // For other multi-character tokens, use cache to avoid re-generating repeatedly
    const cacheDir = path.join(os.tmpdir(), 'lipcoder_tts_cache');
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
    
    const isSpecialChar = category === 'special';
    
    if (token.length > 1 && !isSpecialChar) {
        // Only cache non-special characters
        const sanitized = token.toLowerCase().replace(/[^a-z0-9]+/g, '_');
        const cachedFile = path.join(cacheDir, `${category || 'text'}_${sanitized}.wav`);
        log(`[genTokenAudio] cache check for "${token}" → ${cachedFile}`);
        if (fs.existsSync(cachedFile)) {
            log(`[genTokenAudio] cache HIT for "${token}", returning ${cachedFile}`);
            return cachedFile;
        }
        log(`[genTokenAudio] cache MISS for "${token}", generating new TTS`);
    } else if (isSpecialChar) {
        log(`[genTokenAudio] *** SPECIAL CHARACTER "${token}" - SKIPPING ALL CACHE CHECKS, USING DIRECT TTS INFERENCE ***`);
    }
    
    // Generate TTS (either for cache miss or special characters)
    const { pythonPath: pythonExe, scriptPath, language, modelId, sampleRate } = sileroConfig;
    const baseCategory = category?.split('_')[0];
    const speakerName =
        opts?.speaker
        ?? (baseCategory && categoryVoiceMap[baseCategory])
        ?? sileroConfig.defaultSpeaker!;
    
    // Send text to long-running Silero server
    const ttsPort = serverManager.getServerPort('tts');
    if (!ttsPort) {
        throw new Error('TTS server is not running or port not available');
    }
    const res = await fetch(`http://localhost:${ttsPort}/tts`, {
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
    
    // For special characters, don't cache - return temp file
    // For regular tokens, save to cache
    try {
        if (isSpecialChar) {
            // Special characters: save as WAV file to use same playback path as regular TTS
            // This allows them to benefit from external player fallback (afplay, etc.)
            const outFile = path.join(os.tmpdir(), `tts_special_${Date.now()}_${Math.random().toString(36).slice(2)}.wav`);
            fs.writeFileSync(outFile, wavBuffer);
            log(`[genTokenAudio] *** SPECIAL CHARACTER "${token}" SAVED AS WAV: ${outFile} (NOT CACHED) ***`);
            return outFile;
        } else if (token.length > 1) {
            // Regular multi-character tokens: save to cache with .wav extension (for regular playWave handling)
            const sanitized = token.toLowerCase().replace(/[^a-z0-9]+/g, '_');
            const cachedFile = path.join(cacheDir, `${category || 'text'}_${sanitized}.wav`);
            fs.writeFileSync(cachedFile, wavBuffer);
            log(`[genTokenAudio] cached token saved: ${cachedFile}`);
            return cachedFile;
        } else {
            // Single character fallback - also WAV format
            const outFile = path.join(os.tmpdir(), `tts_single_${Date.now()}_${Math.random().toString(36).slice(2)}.wav`);
            fs.writeFileSync(outFile, wavBuffer);
            return outFile;
        }
    } catch (err) {
        log(`[genTokenAudio] Error saving TTS file: ${err}`);
        throw err;
    }

    // This should not be reached, but just in case
    throw new Error('No text to TTS for token');
}

/**
 * Play special character audio using direct TTS inference
 */
export async function playSpecial(word: string): Promise<void> {
    log(`[playSpecial] *** GENERATING FRESH TTS FOR SPECIAL WORD: "${word}" ***`);
    
    try {
        // Always generate audio using TTS directly, never check cache
        log(`[playSpecial] Calling genTokenAudio with word="${word}", category="special"`);
        const audioFile = await genTokenAudio(word, 'special');
        log(`[playSpecial] Generated audio file: ${audioFile}`);
        
        // Special characters are saved as WAV files, so they use the same playback path as regular TTS
        // This allows them to benefit from external player fallback (afplay, etc.) for correct pitch
        const { playWave } = require('./audio');
        await playWave(audioFile);
        
        log(`[playSpecial] Finished playing special word: "${word}"`);
        
    } catch (error) {
        log(`[playSpecial] ERROR generating TTS for "${word}": ${error}`);
        return Promise.resolve();
    }
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