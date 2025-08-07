import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { fetch, Agent } from 'undici';
import { log } from './utils';
import { config, categoryVoiceMap, sileroConfig, espeakConfig, espeakCategoryVoiceMap, currentBackend, TTSBackend } from './config';
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
    log(`[genTokenAudio] START token="${token}" category="${category}" backend="${currentBackend}"`);

    // 0) Pre-generated keyword audio? (same for both backends)
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
        // Only cache non-special characters - include backend in cache key
        const sanitized = token.toLowerCase().replace(/[^a-z0-9]+/g, '_');
        const cachedFile = path.join(cacheDir, `${currentBackend}_${category || 'text'}_${sanitized}.wav`);
        log(`[genTokenAudio] cache check for "${token}" → ${cachedFile}`);
        if (fs.existsSync(cachedFile)) {
            log(`[genTokenAudio] cache HIT for "${token}", returning ${cachedFile}`);
            return cachedFile;
        }
        log(`[genTokenAudio] cache MISS for "${token}", generating new TTS`);
    } else if (isSpecialChar) {
        log(`[genTokenAudio] *** SPECIAL CHARACTER "${token}" - SKIPPING ALL CACHE CHECKS, USING DIRECT TTS INFERENCE ***`);
    }
    
    // Generate TTS based on current backend
    let wavBuffer: Buffer;
    
    if (currentBackend === TTSBackend.Silero) {
        wavBuffer = await generateSileroTTS(token, category, opts);
    } else if (currentBackend === TTSBackend.Espeak) {
        wavBuffer = await generateEspeakTTS(token, category, opts);
    } else {
        throw new Error(`Unsupported TTS backend: ${currentBackend}`);
    }
    
    // Save the generated audio (caching logic remains the same)
    try {
        if (isSpecialChar) {
            // Special characters: save as WAV file to use same playback path as regular TTS
            // This allows them to benefit from external player fallback (afplay, etc.)
            const outFile = path.join(os.tmpdir(), `tts_special_${currentBackend}_${Date.now()}_${Math.random().toString(36).slice(2)}.wav`);
            fs.writeFileSync(outFile, wavBuffer);
            log(`[genTokenAudio] *** SPECIAL CHARACTER "${token}" SAVED AS WAV: ${outFile} (NOT CACHED) ***`);
            return outFile;
        } else if (token.length > 1) {
            // Regular multi-character tokens: save to cache with .wav extension (for regular playWave handling)
            const sanitized = token.toLowerCase().replace(/[^a-z0-9]+/g, '_');
            const cachedFile = path.join(cacheDir, `${currentBackend}_${category || 'text'}_${sanitized}.wav`);
            fs.writeFileSync(cachedFile, wavBuffer);
            log(`[genTokenAudio] cached token saved: ${cachedFile}`);
            return cachedFile;
        } else {
            // Single character fallback - also WAV format
            const outFile = path.join(os.tmpdir(), `tts_single_${currentBackend}_${Date.now()}_${Math.random().toString(36).slice(2)}.wav`);
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
 * Generate TTS using Silero backend
 */
async function generateSileroTTS(
    token: string,
    category?: string,
    opts?: { speaker?: string }
): Promise<Buffer> {
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
        throw new Error('Silero TTS server is not running. Try switching to Silero TTS backend first.');
    }
    
    log(`[generateSileroTTS] Using Silero server on port ${ttsPort} for token "${token}"`);
    
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
            `[generateSileroTTS] TTS server error ${res.status} ${res.statusText}: ${errorBody}`
        );
        throw new Error(`Silero TTS server error: ${res.status} ${res.statusText}. Server may not be running.`);
    }
    return Buffer.from(await res.arrayBuffer());
}

/**
 * Generate TTS using espeak-ng backend
 */
async function generateEspeakTTS(
    token: string,
    category?: string,
    opts?: { speaker?: string }
): Promise<Buffer> {
    const baseCategory = category?.split('_')[0];
    
    // Get espeak settings for this category
    const categorySettings = (baseCategory && espeakCategoryVoiceMap[baseCategory]) || {};
    const espeakSettings = { ...espeakConfig, ...categorySettings };
    
    // Allow override via opts (using speaker as voice for compatibility)
    if (opts?.speaker) {
        espeakSettings.defaultVoice = opts.speaker;
    }
    
    // Send text to long-running espeak server
    const espeakPort = serverManager.getServerPort('espeak_tts');
    if (!espeakPort) {
        throw new Error('Espeak TTS server is not running. Try switching to espeak-ng TTS backend first.');
    }
    
    log(`[generateEspeakTTS] Using espeak server on port ${espeakPort} for token "${token}"`);
    
    const res = await fetch(`http://localhost:${espeakPort}/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            text: token,
            voice: espeakSettings.defaultVoice,
            speed: espeakSettings.speed,
            pitch: espeakSettings.pitch,
            amplitude: espeakSettings.amplitude,
            gap: espeakSettings.gap,
            sample_rate: espeakSettings.sampleRate,
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
            `[generateEspeakTTS] TTS server error ${res.status} ${res.statusText}: ${errorBody}`
        );
        throw new Error(`Espeak TTS server error: ${res.status} ${res.statusText}. Server may not be running.`);
    }
    return Buffer.from(await res.arrayBuffer());
}

/**
 * Play special character audio using direct TTS inference
 */
export async function playSpecial(word: string): Promise<void> {
    log(`[playSpecial] *** GENERATING FRESH TTS FOR SPECIAL WORD: "${word}" ***`);
    console.log(`[playSpecial] DEBUG: Starting playSpecial for word="${word}"`);
    
    try {
        // Always generate audio using TTS directly, never check cache
        log(`[playSpecial] Calling genTokenAudio with word="${word}", category="special"`);
        console.log(`[playSpecial] DEBUG: About to call genTokenAudio("${word}", "special")`);
        const audioFile = await genTokenAudio(word, 'special');
        log(`[playSpecial] Generated audio file: ${audioFile}`);
        console.log(`[playSpecial] DEBUG: Generated audio file: ${audioFile}`);
        
        // Special characters are saved as WAV files, so they use the same playback path as regular TTS
        // This allows them to benefit from external player fallback (afplay, etc.) for correct pitch
        const { playWave } = require('./audio');
        console.log(`[playSpecial] DEBUG: About to call playWave("${audioFile}")`);
        await playWave(audioFile);
        
        log(`[playSpecial] Finished playing special word: "${word}"`);
        console.log(`[playSpecial] DEBUG: Finished playing special word: "${word}"`);
        
    } catch (error) {
        log(`[playSpecial] ERROR generating TTS for "${word}": ${error}`);
        console.log(`[playSpecial] DEBUG: ERROR: ${error}`);
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
 * Get appropriate speaker/voice for a category based on current TTS backend
 */
export function getSpeakerForCategory(category?: string, opts?: { speaker?: string }): string {
    const baseCategory = category?.split('_')[0];
    
    // If speaker is explicitly provided, use it
    if (opts?.speaker) {
        return opts.speaker;
    }
    
    // Return voice based on current backend
    if (currentBackend === TTSBackend.Silero) {
        return (baseCategory && categoryVoiceMap[baseCategory]) ?? sileroConfig.defaultSpeaker!;
    } else if (currentBackend === TTSBackend.Espeak) {
        // For espeak, we return the defaultVoice from the category-specific config
        const categorySettings = (baseCategory && espeakCategoryVoiceMap[baseCategory]) || {};
        const espeakSettings = { ...espeakConfig, ...categorySettings };
        return espeakSettings.defaultVoice;
    } else {
        // Fallback to Silero for unknown backends
        return (baseCategory && categoryVoiceMap[baseCategory]) ?? sileroConfig.defaultSpeaker!;
    }
}