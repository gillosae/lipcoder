import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { fetch, Agent } from 'undici';
import { log } from './utils';
import { config, categoryVoiceMap, sileroConfig, espeakConfig, espeakCategoryVoiceMap, openaiTTSConfig, openaiCategoryVoiceMap, xttsV2Config, currentBackend, TTSBackend } from './config';
import { isAlphabet, isNumber } from './mapping';
import { serverManager } from './server_manager';
import { detectLanguage, DetectedLanguage, shouldUseKoreanTTS, shouldUseEnglishTTS } from './language_detection';

// Keep-alive agent for HTTP fetch to reuse connections
const keepAliveAgent = new Agent({ keepAliveTimeout: 60000 });

// Note: specialWordCache removed - now using direct TTS inference

// Valid OpenAI TTS voice names
const VALID_OPENAI_VOICES = ['nova', 'shimmer', 'echo', 'onyx', 'fable', 'alloy', 'ash', 'sage', 'coral'];

/**
 * Check if a voice name is valid for OpenAI TTS
 */
function isValidOpenAIVoice(voice: string): boolean {
    return VALID_OPENAI_VOICES.includes(voice);
}

/**
 * Generate (but don't play) audio for a token
 */
export async function genTokenAudio(
    token: string,
    category?: string,
    opts?: { speaker?: string; abortSignal?: AbortSignal }
): Promise<string> {
    const startTime = Date.now();
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

    // 0.1) Pre-generated alphabet audio for single letters
    // Use PCM files for single letters in variable names, special chars, etc.
    // Skip for keywords and types which might need different pronunciation
    const useAlphabetPCM = token.length === 1 && isAlphabet(token) && 
        (category === 'special' || category === 'variable' || category === 'literal');
    
    if (useAlphabetPCM) {
        const filename = token.toLowerCase();
        const filePath = path.join(config.audioPath(), 'alphabet', `${filename}.pcm`);
        log(`[genTokenAudio] looking up alphabet PCM at ${filePath}, exists=${fs.existsSync(filePath)}`);
        if (fs.existsSync(filePath)) {
            log(`[genTokenAudio] *** ALPHABET BYPASS: using pre-generated PCM for "${token}" (${category}) at ${filePath} ***`);
            return filePath;  // skip TTS entirely for fast alphabet playback
        } else {
            log(`[genTokenAudio] Alphabet PCM not found for "${token}" (${category}), falling back to TTS`);
        }
    } else if (token.length === 1 && isAlphabet(token)) {
        log(`[genTokenAudio] Single letter "${token}" with category "${category}" - using TTS for context-specific pronunciation`);
    }

    // 0.2) Pre-generated number audio for single digits
    // Use PCM files for single digits in variable names, literals, etc.
    if (token.length === 1 && isNumber(token) && (category === 'special' || category === 'variable' || category === 'literal')) {
        const filename = token;  // digits are already 0-9
        const filePath = path.join(config.audioPath(), 'number', `${filename}.pcm`);
        log(`[genTokenAudio] looking up number PCM at ${filePath}, exists=${fs.existsSync(filePath)}`);
        if (fs.existsSync(filePath)) {
            log(`[genTokenAudio] *** NUMBER BYPASS: using pre-generated PCM for "${token}" (${category}) at ${filePath} ***`);
            return filePath;  // skip TTS entirely for fast number playback
        }
    }

    // 0.5) For special characters, skip caching and always generate fresh TTS
    // For other multi-character tokens, use cache to avoid re-generating repeatedly
    const cacheDir = path.join(os.tmpdir(), 'lipcoder_tts_cache');
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
    
    const isSpecialChar = category === 'special';
    
    if (token.length > 1 && !isSpecialChar) {
        // Only cache non-special characters - include backend and language in cache key
        // Optimize: detect language once and reuse
        const detectedLang = detectLanguage(token);
        // Use the actual current backend for all languages, not hardcoded 'openai_ko' for Korean
        const effectiveBackend = currentBackend;
        
        // Create a proper cache key that preserves Korean characters
        let sanitized: string;
        if (detectedLang === DetectedLanguage.Korean) {
            // For Korean text, use a hash to create a unique but safe filename
            const crypto = require('crypto');
            sanitized = crypto.createHash('md5').update(token).digest('hex').substring(0, 8);
            log(`[genTokenAudio] Korean token "${token}" → hash: ${sanitized}`);
        } else {
            // For English text, use the original sanitization
            sanitized = token.toLowerCase().replace(/[^a-z0-9]+/g, '_');
        }
        
        const cachedFile = path.join(cacheDir, `${effectiveBackend}_${detectedLang}_${category || 'text'}_${sanitized}.wav`);
        log(`[genTokenAudio] cache check for "${token}" (${detectedLang}) → ${cachedFile}`);
        if (fs.existsSync(cachedFile)) {
            log(`[genTokenAudio] cache HIT for "${token}", returning ${cachedFile}`);
            return cachedFile;
        }
        log(`[genTokenAudio] cache MISS for "${token}", generating new TTS`);
    } else if (isSpecialChar) {
        log(`[genTokenAudio] *** SPECIAL CHARACTER "${token}" - SKIPPING ALL CACHE CHECKS, USING DIRECT TTS INFERENCE ***`);
    }
    
    // Generate TTS based on language detection and current backend
    let wavBuffer: Buffer;
    
    // Language-based TTS routing: Korean text always uses OpenAI TTS
    // Optimize by detecting language only once and reusing the result
    const detectedLanguage = detectLanguage(token);
    const useKoreanTTS = detectedLanguage === DetectedLanguage.Korean; // Direct check instead of function call
    log(`[genTokenAudio] Language detection for "${token}": ${detectedLanguage}, useKoreanTTS: ${useKoreanTTS}`);
    
    // Handle the three combined backend options
    if (currentBackend === TTSBackend.SileroGPT) {
        // Silero for English + GPT for Korean
        if (useKoreanTTS) {
            log(`[genTokenAudio] Korean text detected, using OpenAI TTS (Silero+GPT backend): "${token}"`);
            const koreanOpts = opts?.speaker && isValidOpenAIVoice(opts.speaker) 
                ? { speaker: opts.speaker, abortSignal: opts?.abortSignal }
                : { abortSignal: opts?.abortSignal };
            wavBuffer = await generateOpenAITTS(token, category, koreanOpts);
        } else {
            log(`[genTokenAudio] English text detected, using Silero TTS (Silero+GPT backend): "${token}"`);
            wavBuffer = await generateSileroTTS(token, category, opts);
        }
    } else if (currentBackend === TTSBackend.EspeakGPT) {
        // Espeak for English + GPT for Korean
        if (useKoreanTTS) {
            log(`[genTokenAudio] Korean text detected, using OpenAI TTS (Espeak+GPT backend): "${token}"`);
            const koreanOpts = opts?.speaker && isValidOpenAIVoice(opts.speaker) 
                ? { speaker: opts.speaker, abortSignal: opts?.abortSignal }
                : { abortSignal: opts?.abortSignal };
            wavBuffer = await generateOpenAITTS(token, category, koreanOpts);
        } else {
            log(`[genTokenAudio] English text detected, using Espeak TTS (Espeak+GPT backend): "${token}"`);
            wavBuffer = await generateEspeakTTS(token, category, opts);
        }
    } else if (currentBackend === TTSBackend.XTTSV2) {
        // XTTS-v2 for both Korean and English
        const xttsV2Port = serverManager.getServerPort('xtts_v2');
        if (xttsV2Port !== null) {
            log(`[genTokenAudio] Using XTTS-v2 for "${token}" (language: ${useKoreanTTS ? 'Korean' : 'English'})`);
            try {
                wavBuffer = await generateXTTSV2(token, category, opts);
                log(`[genTokenAudio] XTTS-v2 successful for "${token}"`);
            } catch (error) {
                // Check if the error is due to abort signal - if so, don't fallback, just re-throw
                if (opts?.abortSignal?.aborted || (error instanceof Error && error.message.includes('aborted'))) {
                    log(`[genTokenAudio] XTTS-v2 aborted for "${token}", not falling back to avoid cascade`);
                    throw error;
                }
                
                log(`[genTokenAudio] XTTS-v2 failed for "${token}", falling back to OpenAI TTS. Error: ${error}`);
                // Fallback to OpenAI TTS if XTTS-v2 fails (but not if aborted)
                const fallbackOpts = opts?.speaker && isValidOpenAIVoice(opts.speaker) 
                    ? { speaker: opts.speaker, abortSignal: opts?.abortSignal }
                    : { abortSignal: opts?.abortSignal };
                wavBuffer = await generateOpenAITTS(token, category, fallbackOpts);
            }
        } else {
            log(`[genTokenAudio] XTTS-v2 server not available, falling back to OpenAI TTS for: "${token}"`);
            const fallbackOpts = opts?.speaker && isValidOpenAIVoice(opts.speaker) 
                ? { speaker: opts.speaker, abortSignal: opts?.abortSignal }
                : { abortSignal: opts?.abortSignal };
            wavBuffer = await generateOpenAITTS(token, category, fallbackOpts);
        }
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
            const detectedLang = detectLanguage(token);
            // Use the actual current backend for all languages, not hardcoded 'openai_ko' for Korean
            const effectiveBackend = currentBackend;
            
            // Create the same cache key as used for lookup
            let sanitized: string;
            if (detectedLang === DetectedLanguage.Korean) {
                // For Korean text, use a hash to create a unique but safe filename
                const crypto = require('crypto');
                sanitized = crypto.createHash('md5').update(token).digest('hex').substring(0, 8);
            } else {
                // For English text, use the original sanitization
                sanitized = token.toLowerCase().replace(/[^a-z0-9]+/g, '_');
            }
            
            const cachedFile = path.join(cacheDir, `${effectiveBackend}_${detectedLang}_${category || 'text'}_${sanitized}.wav`);
            fs.writeFileSync(cachedFile, wavBuffer);
            
            // Performance monitoring for Korean TTS
            const processingTime = Date.now() - startTime;
            if (detectedLang === DetectedLanguage.Korean) {
                log(`[genTokenAudio] Korean TTS completed in ${processingTime}ms for "${token}"`);
            }
            
            log(`[genTokenAudio] cached token saved: ${cachedFile} for "${token}"`);
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
 * Generate TTS using OpenAI backend with cancellation support
 */
async function generateOpenAITTS(
    token: string,
    category?: string,
    opts?: { speaker?: string; abortSignal?: AbortSignal }
): Promise<Buffer> {
    const baseCategory = category?.split('_')[0];
    
    // Get OpenAI settings for this category
    const categorySettings = (baseCategory && openaiCategoryVoiceMap[baseCategory]) || {};
    const openaiSettings = { ...openaiTTSConfig, ...categorySettings };
    
    // Allow override via opts, but validate it's a valid OpenAI voice
    if (opts?.speaker) {
        if (isValidOpenAIVoice(opts.speaker)) {
            openaiSettings.voice = opts.speaker;
        } else {
            // If speaker is a Silero voice (like en_41), use default OpenAI voice
            log(`[generateOpenAITTS] Invalid OpenAI voice "${opts.speaker}", using default "${openaiSettings.voice}"`);
        }
    }
    
    // Detect language and adjust settings accordingly
    const detectedLang = detectLanguage(token);
    if (detectedLang === DetectedLanguage.Korean) {
        // Use Korean-optimized settings
        openaiSettings.language = 'ko';
        log(`[generateOpenAITTS] Korean text detected, using Korean language setting`);
    } else {
        // Use English settings for non-Korean text
        openaiSettings.language = 'en';
    }
    
    // Check if API key is available
    if (!openaiSettings.apiKey) {
        log(`[generateOpenAITTS] ERROR: OpenAI API key not configured for token "${token}"`);
        throw new Error('OpenAI API key not configured. Please set lipcoder.openaiApiKey in VS Code settings.');
    }
    
    log(`[generateOpenAITTS] Using OpenAI TTS for token "${token}" with voice "${openaiSettings.voice}" and language "${openaiSettings.language}"`);
    log(`[generateOpenAITTS] OpenAI settings: model=${openaiSettings.model}, speed=${openaiSettings.speed}`);
    
    // Check for cancellation before starting
    if (opts?.abortSignal?.aborted) {
        log(`[generateOpenAITTS] Request aborted before starting for token: "${token}"`);
        throw new Error('OpenAI TTS request was aborted');
    }
    
    try {
        // Import OpenAI client (optimized - reduce logging for performance)
        const { getOpenAIClient } = await import('./llm.js');
        const client = getOpenAIClient();
        
        // Check for cancellation after client creation
        if (opts?.abortSignal?.aborted) {
            log(`[generateOpenAITTS] Request aborted after client creation for token: "${token}"`);
            throw new Error('OpenAI TTS request was aborted');
        }
        
        // Load configuration to ensure API key is fresh (optimized - reduce logging)
        const { loadConfigFromSettings } = await import('./config.js');
        loadConfigFromSettings();
        
        // Check for cancellation before making request
        if (opts?.abortSignal?.aborted) {
            log(`[generateOpenAITTS] Request aborted before API call for token: "${token}"`);
            throw new Error('OpenAI TTS request was aborted');
        }
        
        // Create TTS request with timeout and abort signal support
        log(`[generateOpenAITTS] Making OpenAI TTS request for token: "${token}"`);
        const response = await client.audio.speech.create({
            model: openaiSettings.model,
            voice: openaiSettings.voice as any, // OpenAI voice type
            input: token,
            response_format: 'wav', // Always use WAV for consistency
            speed: openaiSettings.speed,
        }, {
            // Add timeout and signal support
            timeout: 10000, // 10 second timeout for Korean TTS
            signal: opts?.abortSignal
        });
        
        // Convert response to buffer
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        
        log(`[generateOpenAITTS] Successfully generated ${buffer.length} bytes of audio for token "${token}" (${openaiSettings.language})`);
        return buffer;
        
    } catch (error) {
        log(`[generateOpenAITTS] Error generating TTS for token "${token}": ${error}`);
        throw new Error(`OpenAI TTS error: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/**
 * Generate TTS using XTTS-v2 backend
 */
async function generateXTTSV2(
    token: string,
    category?: string,
    opts?: { speaker?: string; abortSignal?: AbortSignal }
): Promise<Buffer> {
    log(`[generateXTTSV2] Using XTTS-v2 for token "${token}"`);
    
    // Check if XTTS-v2 server is running
    const xttsV2Port = serverManager.getServerPort('xtts_v2');
    if (!xttsV2Port) {
        throw new Error('XTTS-v2 server is not running. Try switching to XTTS-v2 backend first.');
    }
    
    log(`[generateXTTSV2] Using XTTS-v2 server on port ${xttsV2Port} for token "${token}"`);
    
    // Check for cancellation before starting
    if (opts?.abortSignal?.aborted) {
        log(`[generateXTTSV2] Request aborted before starting for token: "${token}"`);
        throw new Error('XTTS-v2 request was aborted');
    }
    
    try {
        // Start latency measurement
        const startTime = Date.now();
        // Determine language based on detection
        const detectedLanguage = detectLanguage(token);
        const language = detectedLanguage === DetectedLanguage.Korean ? 'ko' : 'en';
        log(`[generateXTTSV2] Language detection: token="${token}" -> detected=${detectedLanguage} -> language="${language}"`);
        
        const requestBody: any = {
            text: token,
            language: language,
            sample_rate: xttsV2Config.sampleRate,
        };
        
        // Add category for voice selection
        if (category) {
            // Extract base category (remove suffixes like _comment, _keyword, etc.)
            const baseCategory = category.split('_')[0];
            requestBody.category = baseCategory;
        }
        
        // Add speaker reference if configured (overrides category-based selection)
        if (xttsV2Config.speakerWav) {
            requestBody.speaker_wav = xttsV2Config.speakerWav;
        }
        
        // Try the fast endpoint first for optimized voice switching with cached embeddings
        let res = await fetch(`http://localhost:${xttsV2Port}/tts_fast`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody),
            dispatcher: keepAliveAgent,
            signal: opts?.abortSignal
        });
        
        // Fallback to regular endpoint if fast endpoint is not available
        if (!res.ok && res.status === 404) {
            log(`[generateXTTSV2] Fast endpoint not available, falling back to regular endpoint`);
            res = await fetch(`http://localhost:${xttsV2Port}/tts`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody),
                dispatcher: keepAliveAgent,
                signal: opts?.abortSignal
            });
        }
        
        if (!res.ok) {
            // Capture and log the error body for debugging
            let errorBody: string;
            try {
                errorBody = await res.text();
            } catch {
                errorBody = '<unable to read response body>';
            }
            log(
                `[generateXTTSV2] XTTS-v2 server error ${res.status} ${res.statusText}: ${errorBody}`
            );
            throw new Error(`XTTS-v2 server error: ${res.status} ${res.statusText}. Server may not be running.`);
        }
        
        const buffer = Buffer.from(await res.arrayBuffer());
        
        // Log latency performance
        const totalTime = Date.now() - startTime;
        log(`[generateXTTSV2] Successfully generated ${buffer.length} bytes of audio for token "${token}" in ${totalTime}ms`);
        
        // Log performance metrics for optimization tracking
        if (category) {
            log(`[generateXTTSV2] Performance: category="${category}", latency=${totalTime}ms, text_length=${token.length}, audio_size=${buffer.length}bytes`);
        }
        
        return buffer;
        
    } catch (error) {
        log(`[generateXTTSV2] Error generating TTS for token "${token}": ${error}`);
        throw new Error(`XTTS-v2 error: ${error instanceof Error ? error.message : String(error)}`);
    }
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
 * Get appropriate speaker/voice for a category based on current TTS backend
 */
export function getSpeakerForCategory(category?: string, opts?: { speaker?: string }): string {
    const baseCategory = category?.split('_')[0];
    
    // Debug logging for comment categories
    if (category?.includes('comment')) {
        log(`[getSpeakerForCategory] Comment category debug: "${category}" → baseCategory: "${baseCategory}", backend: ${currentBackend}`);
        if (currentBackend === TTSBackend.SileroGPT) {
            log(`[getSpeakerForCategory] Silero voice map for "${baseCategory}": ${categoryVoiceMap[baseCategory || '']}, default: ${sileroConfig.defaultSpeaker}`);
        }
    }
    
    // If speaker is explicitly provided, use it
    if (opts?.speaker) {
        return opts.speaker;
    }
    
    // Return voice based on current backend
    if (currentBackend === TTSBackend.SileroGPT) {
        // For Silero+GPT backend, use Silero voices for English, OpenAI for Korean
        const voice = (baseCategory && categoryVoiceMap[baseCategory]) ?? sileroConfig.defaultSpeaker!;
        if (category?.includes('comment')) {
            log(`[getSpeakerForCategory] Returning Silero voice for comment (Silero+GPT): ${voice}`);
        }
        return voice;
    } else if (currentBackend === TTSBackend.EspeakGPT) {
        // For Espeak+GPT backend, use Espeak voices for English, OpenAI for Korean
        const categorySettings = (baseCategory && espeakCategoryVoiceMap[baseCategory]) || {};
        const espeakSettings = { ...espeakConfig, ...categorySettings };
        const voice = espeakSettings.defaultVoice;
        if (category?.includes('comment')) {
            log(`[getSpeakerForCategory] Returning Espeak voice for comment (Espeak+GPT): ${voice}`);
        }
        return voice;
    } else if (currentBackend === TTSBackend.XTTSV2) {
        // For XTTS-v2, we don't have speaker selection (handles both languages)
        // Return a default identifier for consistency
        const voice = 'xtts-v2';
        if (category?.includes('comment')) {
            log(`[getSpeakerForCategory] Returning XTTS-v2 voice for comment: ${voice}`);
        }
        return voice;
    } else {
        // Fallback to Silero for unknown backends
        const voice = (baseCategory && categoryVoiceMap[baseCategory]) ?? sileroConfig.defaultSpeaker!;
        if (category?.includes('comment')) {
            log(`[getSpeakerForCategory] Returning fallback Silero voice for comment: ${voice}`);
        }
        return voice;
    }
}