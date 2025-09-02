import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { fetch, Agent } from 'undici';
import type { Response as UndiciResponse } from 'undici';
import { log, logWarning } from './utils';
import { config, categoryVoiceMap, sileroConfig, espeakConfig, espeakCategoryVoiceMap, openaiTTSConfig, openaiCategoryVoiceMap, xttsV2Config, macosConfig, macosCategoryVoiceMap, currentBackend, TTSBackend } from './config';
import { isAlphabet, isNumber } from './mapping';
import { serverManager } from './server_manager';
import { detectLanguage, DetectedLanguage, shouldUseKoreanTTS, shouldUseEnglishTTS } from './language_detection';

// Keep-alive agent for HTTP fetch to reuse connections
const keepAliveAgent = new Agent({ keepAliveTimeout: 60000 });

/**
 * Dispose the TTS HTTP keep-alive agent to free sockets/memory
 */
export function disposeTTSAgent(): void {
    try {
        // Close idle sockets and prevent new requests from reusing the agent
        // Undici Agent supports close() for graceful shutdown
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        keepAliveAgent.close();
        log('[TTS] Keep-alive agent closed');
    } catch (error) {
        logWarning(`[TTS] Failed to close keep-alive agent: ${error}`);
    }
}

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
// Helper function to convert regex patterns to readable text
function convertRegexToReadableText(regexToken: string): string {
    // Convert common regex patterns to more readable forms
    let readable = regexToken;
    
    // Handle raw string prefixes
    readable = readable.replace(/^r['"]/, 'raw string ');
    readable = readable.replace(/['"]$/, '');
    
    // Convert character classes
    readable = readable.replace(/\[([^\]]+)\]/g, (match, content) => {
        if (content === 'a-zA-Z') return 'any letter';
        if (content === '0-9') return 'any digit';
        if (content === 'a-z') return 'any lowercase letter';
        if (content === 'A-Z') return 'any uppercase letter';
        if (content === 'a-zA-Z0-9') return 'any alphanumeric character';
        return `character class ${content}`;
    });
    
    // Convert common regex symbols
    readable = readable.replace(/\+/g, ' one or more');
    readable = readable.replace(/\*/g, ' zero or more');
    readable = readable.replace(/\?/g, ' optional');
    readable = readable.replace(/\^/g, 'start of line ');
    readable = readable.replace(/\$/g, ' end of line');
    readable = readable.replace(/\./g, ' any character');
    
    return readable.trim();
}

export async function genTokenAudio(
    token: string,
    category?: string,
    opts?: { speaker?: string; abortSignal?: AbortSignal }
): Promise<string> {
    const startTime = Date.now();
    log(`[genTokenAudio] START token="${token}" category="${category}" backend="${currentBackend}"`);
    log(`[genTokenAudio] Call stack: ${new Error().stack?.split('\n')[2]?.trim()}`);

    // Handle regex patterns - convert to readable text
    let processedToken = token;
    if (category === 'regex_pattern') {
        processedToken = convertRegexToReadableText(token);
        log(`[genTokenAudio] Converted regex "${token}" → "${processedToken}"`);
    }

    // 0) Pre-generated keyword audio (backend-specific folders)
    if (category && (category === 'keyword' || category.includes('keyword'))) {
        const filename = token.toLowerCase();
        const dirs: string[] = [];
        if (category.includes('python')) {
            dirs.push(config.pythonKeywordsPath());
        } else if (category.includes('typescript')) {
            dirs.push(config.typescriptKeywordsPath());
        } else {
            // If language not specified in category, try both
            dirs.push(config.pythonKeywordsPath(), config.typescriptKeywordsPath());
        }
        log(`[genTokenAudio] Current backend: ${currentBackend}, Keyword dirs: ${dirs.join(', ')}`);
        for (const baseDir of dirs) {
            const wavPath = path.join(baseDir, `${filename}.wav`);
            const pcmPath = path.join(baseDir, `${filename}.pcm`);
            log(`[genTokenAudio] looking up keyword asset at ${wavPath} or ${pcmPath}`);
            if (fs.existsSync(wavPath)) {
                log(`[genTokenAudio] keyword bypass (WAV): using ${wavPath}`);
                return wavPath;  // prefer WAV to match playTtsAsPcm
            }
            if (fs.existsSync(pcmPath)) {
                log(`[genTokenAudio] keyword bypass (PCM): using ${pcmPath}`);
                return pcmPath;  // fallback to PCM if WAV missing
            }
        }
        log(`[genTokenAudio] keyword asset not found for "${token}" (${category}), falling back to TTS`);
    }

    // Skip special character processing for ASR responses (vibe_text category)
    // This prevents spaces from being converted to "space" earcons
    if (category === 'vibe_text') {
        log(`[genTokenAudio] ASR response mode - bypassing special character processing for: "${token}"`);
    } else {
        // 0.1) Pre-generated alphabet audio for single letters - OPTIMIZED FOR SPEED
        // Use PCM files for single letters in variable names, special chars, etc.
        // Also use for navigation (no category) and other general cases
        // Skip for keywords and types which might need different pronunciation
        const useAlphabetPCM = token.length === 1 && isAlphabet(token) && 
            (category === 'special' || category === 'variable' || category === 'literal' || 
             category === undefined || category === null || category === '');
        
        if (useAlphabetPCM) {
            const filename = token.toLowerCase();
            const alphabetPath = config.alphabetPath();
            // OPTIMIZATION: Check PCM first as it's faster to load
            const pcmPath = path.join(alphabetPath, `${filename}.pcm`);
            const wavPath = path.join(alphabetPath, `${filename}.wav`);
            log(`[genTokenAudio] ALPHABET OPTIMIZATION: Fast lookup for "${token}"`);
            if (fs.existsSync(pcmPath)) {
                log(`[genTokenAudio] *** ALPHABET BYPASS (PCM): ${pcmPath}`);
                return pcmPath;
            }
            if (fs.existsSync(wavPath)) {
                log(`[genTokenAudio] *** ALPHABET BYPASS (WAV): ${wavPath}`);
                return wavPath;
            }
            log(`[genTokenAudio] Alphabet asset not found for "${token}" (${category}), falling back to TTS`);
        } else if (token.length === 1 && isAlphabet(token)) {
            log(`[genTokenAudio] Single letter "${token}" with category "${category}" - not using alphabet PCM (useAlphabetPCM=${useAlphabetPCM})`);
        }

        // 0.2) Pre-generated number audio for single digits
        // Use PCM files for single digits in variable names, literals, etc.
        if (token.length === 1 && isNumber(token) && (category === 'special' || category === 'variable' || category === 'literal')) {
            const filename = token;  // digits are already 0-9
            const numPcmPath = path.join(config.numberPath(), `${filename}.pcm`);
            const numWavPath = path.join(config.numberPath(), `${filename}.wav`);
            log(`[genTokenAudio] looking up number assets at ${numPcmPath} or ${numWavPath}`);
            if (fs.existsSync(numPcmPath)) {
                log(`[genTokenAudio] *** NUMBER BYPASS (PCM): ${numPcmPath}`);
                return numPcmPath;  // skip TTS entirely for fast number playback
            }
            if (fs.existsSync(numWavPath)) {
                log(`[genTokenAudio] *** NUMBER BYPASS (WAV): ${numWavPath}`);
                return numWavPath;  // skip TTS entirely for fast number playback
            }
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
            // For English text, use sanitization with length limit to prevent filename too long errors
            let baseSanitized = token.toLowerCase().replace(/[^a-z0-9]+/g, '_');
            
            // If the sanitized filename is too long, use a hash approach similar to Korean
            if (baseSanitized.length > 100) {
                const crypto = require('crypto');
                const hash = crypto.createHash('md5').update(token).digest('hex').substring(0, 8);
                const truncated = baseSanitized.substring(0, 50); // Keep first 50 chars for readability
                sanitized = `${truncated}_${hash}`;
                log(`[genTokenAudio] Long English token (${baseSanitized.length} chars) → truncated: ${sanitized}`);
            } else {
                sanitized = baseSanitized;
            }
        }
        
        // Ensure category is properly included in cache key to prevent voice conflicts
        const safeCategory = category || 'text';
        const cachedFile = path.join(cacheDir, `${effectiveBackend}_${detectedLang}_${safeCategory}_${sanitized}.wav`);
        log(`[genTokenAudio] cache check for "${token}" (${detectedLang}) category="${safeCategory}" → ${cachedFile}`);
        if (fs.existsSync(cachedFile)) {
            log(`[genTokenAudio] cache HIT for "${token}" with category "${safeCategory}", returning ${cachedFile}`);
            return cachedFile;
        }
        log(`[genTokenAudio] cache MISS for "${token}" with category "${safeCategory}", generating new TTS`);
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
    
    // If this is vibe coding text OR vibe coding is currently active, force OpenAI TTS (GPT)
    let isVibeCodingActive = false;
    try {
        const { getVibeCodingTTSActive } = await import('./features/vibe_coding.js');
        isVibeCodingActive = getVibeCodingTTSActive();
    } catch (error) {
        log(`[genTokenAudio] Warning: Could not import vibe coding state: ${error}`);
    }
    
    // Enhanced logging for debugging
    log(`[genTokenAudio] TTS routing check: category="${category}", isVibeCodingActive=${isVibeCodingActive}, backend="${currentBackend}"`);
    
    if (category === 'vibe_text' || isVibeCodingActive) {
        const gptOpts = opts?.speaker && isValidOpenAIVoice(opts.speaker)
            ? { speaker: opts.speaker, abortSignal: opts?.abortSignal }
            : { abortSignal: opts?.abortSignal };
        log(`[genTokenAudio] *** FORCING OPENAI TTS *** - Vibe coding detected (category: ${category}, active: ${isVibeCodingActive}) for: "${token}"`);
        wavBuffer = await generateOpenAITTS(token, category, gptOpts);
    } else if (currentBackend === TTSBackend.SileroGPT) {
        // Silero for English + GPT for Korean
        if (useKoreanTTS) {
            log(`[genTokenAudio] Korean text detected, using OpenAI TTS (Silero+GPT backend): "${token}"`);
            const koreanOpts = opts?.speaker && isValidOpenAIVoice(opts.speaker) 
                ? { speaker: opts.speaker, abortSignal: opts?.abortSignal }
                : { abortSignal: opts?.abortSignal };
            wavBuffer = await generateOpenAITTS(processedToken, category, koreanOpts);
        } else {
            log(`[genTokenAudio] English text detected, using Silero TTS (Silero+GPT backend): "${token}"`);
            wavBuffer = await generateSileroTTS(processedToken, category, opts);
        }
    } else if (currentBackend === TTSBackend.EspeakGPT) {
        // Espeak for English + GPT for Korean
        if (useKoreanTTS) {
            log(`[genTokenAudio] Korean text detected, using OpenAI TTS (Espeak+GPT backend): "${token}"`);
            const koreanOpts = opts?.speaker && isValidOpenAIVoice(opts.speaker) 
                ? { speaker: opts.speaker, abortSignal: opts?.abortSignal }
                : { abortSignal: opts?.abortSignal };
            wavBuffer = await generateOpenAITTS(processedToken, category, koreanOpts);
        } else {
            log(`[genTokenAudio] English text detected, using Espeak TTS (Espeak+GPT backend): "${token}"`);
            wavBuffer = await generateEspeakTTS(processedToken, category, opts);
        }
    } else if (currentBackend === TTSBackend.Espeak) {
        // Espeak for all languages (including Korean)
        log(`[genTokenAudio] Using Espeak TTS for all languages: "${token}" (${useKoreanTTS ? 'Korean' : 'English'})`);
        wavBuffer = await generateEspeakTTS(processedToken, category, opts);
    } else if (currentBackend === TTSBackend.XTTSV2) {
        // XTTS-v2 for both Korean and English
        const xttsV2Port = serverManager.getServerPort('xtts_v2');
        if (xttsV2Port !== null) {
            log(`[genTokenAudio] Using XTTS-v2 for "${token}" (language: ${useKoreanTTS ? 'Korean' : 'English'})`);
            try {
                wavBuffer = await generateXTTSV2(processedToken, category, opts);
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
    } else if (currentBackend === TTSBackend.MacOSGPT) {
        // macOS for English + GPT for Korean
        if (useKoreanTTS) {
            log(`[genTokenAudio] Korean text detected, using OpenAI TTS (macOS+GPT backend): "${token}"`);
            const koreanOpts = opts?.speaker && isValidOpenAIVoice(opts.speaker) 
                ? { speaker: opts.speaker, abortSignal: opts?.abortSignal }
                : { abortSignal: opts?.abortSignal };
            wavBuffer = await generateOpenAITTS(processedToken, category, koreanOpts);
        } else {
            log(`[genTokenAudio] English text detected, using macOS TTS (macOS+GPT backend): "${token}"`);
            wavBuffer = await generateMacOSTTS(processedToken, category, opts);
        }
    } else if (currentBackend === TTSBackend.MacOS) {
        // macOS for all languages (including Korean)
        log(`[genTokenAudio] Using macOS TTS for all languages: "${token}" (${useKoreanTTS ? 'Korean' : 'English'})`);
        wavBuffer = await generateMacOSTTS(processedToken, category, opts);
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
                // For English text, use sanitization with length limit to prevent filename too long errors
                let baseSanitized = token.toLowerCase().replace(/[^a-z0-9]+/g, '_');
                
                // If the sanitized filename is too long, use a hash approach similar to Korean
                if (baseSanitized.length > 100) {
                    const crypto = require('crypto');
                    const hash = crypto.createHash('md5').update(token).digest('hex').substring(0, 8);
                    const truncated = baseSanitized.substring(0, 50); // Keep first 50 chars for readability
                    sanitized = `${truncated}_${hash}`;
                    log(`[genTokenAudio] Long English token (${baseSanitized.length} chars) → truncated: ${sanitized}`);
                } else {
                    sanitized = baseSanitized;
                }
            }
            
            const safeCategory = category || 'text';
            const cachedFile = path.join(cacheDir, `${effectiveBackend}_${detectedLang}_${safeCategory}_${sanitized}.wav`);
            fs.writeFileSync(cachedFile, wavBuffer);
            
            // Performance monitoring for Korean TTS
            const processingTime = Date.now() - startTime;
            if (detectedLang === DetectedLanguage.Korean) {
                log(`[genTokenAudio] Korean TTS completed in ${processingTime}ms for "${token}"`);
            }
            
            log(`[genTokenAudio] cached token saved with category "${safeCategory}": ${cachedFile} for "${token}"`);
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
    log(`[generateSileroTTS] Voice selection for token="${token}" category="${category}" baseCategory="${baseCategory}" → speaker="${speakerName}"`);
    
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
// Load balancer for dual espeak servers
let espeakServerIndex = 0;
function getNextEspeakServer(): number {
    const primaryPort = serverManager.getServerPort('espeak_tts');
    const secondaryPort = serverManager.getServerPort('espeak_tts_2');
    
    // If both servers are available, alternate between them
    if (primaryPort && secondaryPort) {
        const port = espeakServerIndex === 0 ? primaryPort : secondaryPort;
        espeakServerIndex = (espeakServerIndex + 1) % 2; // Alternate between 0 and 1
        return port;
    }
    
    // Fallback to whichever server is available
    return primaryPort || secondaryPort || 0;
}

async function generateEspeakTTS(
    token: string,
    category?: string,
    opts?: { speaker?: string }
): Promise<Buffer> {
    const baseCategory = category?.split('_')[0];
    
    // Get espeak settings for this category
    const categorySettings = (baseCategory && espeakCategoryVoiceMap[baseCategory]) || {};
    const espeakSettings = { ...espeakConfig, ...categorySettings };
    
    // Detect language and set appropriate voice
    const detectedLanguage = detectLanguage(token);
    if (detectedLanguage === DetectedLanguage.Korean) {
        espeakSettings.defaultVoice = 'ko';  // Use Korean voice for Korean text
        log(`[generateEspeakTTS] Korean text detected, using Korean voice: "${token}"`);
    }
    
    // Allow override via opts (using speaker as voice for compatibility)
    if (opts?.speaker) {
        espeakSettings.defaultVoice = opts.speaker;
    }
    
    // Get next available espeak server (load balancing)
    const espeakPort = getNextEspeakServer();
    if (!espeakPort) {
        throw new Error('No Espeak TTS servers are running. Try switching to espeak-ng TTS backend first.');
    }
    
    log(`[generateEspeakTTS] Using espeak server on port ${espeakPort} for token "${token}" (load balanced)`);
    
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
    log(`[generateOpenAITTS] Voice selection for token="${token}" category="${category}" baseCategory="${baseCategory}" → voice="${openaiSettings.voice}" speed="${openaiSettings.speed}"`);
    
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
 * Generate TTS using macOS native voice backend
 */
async function generateMacOSTTS(
    token: string,
    category?: string,
    opts?: { speaker?: string }
): Promise<Buffer> {
    const baseCategory = category?.split('_')[0];
    
    // Get macOS settings for this category
    const categorySettings = (baseCategory && macosCategoryVoiceMap[baseCategory]) || {};
    const macosSettings = { ...macosConfig, ...categorySettings };
    
    // Detect language and set appropriate voice
    const detectedLanguage = detectLanguage(token);
    if (detectedLanguage === DetectedLanguage.Korean) {
        // For Korean text, use Yuna voice if available, otherwise keep default
        if (macosSettings.defaultVoice !== 'Yuna') {
            macosSettings.defaultVoice = 'Yuna';
            log(`[generateMacOSTTS] Korean text detected, switching to Yuna voice: "${token}"`);
        } else {
            log(`[generateMacOSTTS] Korean text detected, using Yuna voice: "${token}"`);
        }
    } else if (token === 'underscore') {
        // Force Yuna voice for underscore
        macosSettings.defaultVoice = 'Yuna';
        log(`[generateMacOSTTS] Underscore detected, forcing Yuna voice: "${token}"`);
    } else {
        log(`[generateMacOSTTS] English text detected, using voice "${macosSettings.defaultVoice}": "${token}"`);
    }
    
    // Allow override via opts (using speaker as voice for compatibility)
    if (opts?.speaker) {
        macosSettings.defaultVoice = opts.speaker;
    }
    
    // Send text to macOS TTS server
    let macosPort = serverManager.getServerPort('macos_tts');
    if (!macosPort) {
        log(`[generateMacOSTTS] macOS TTS server not running, attempting to start it...`);
        try {
            await serverManager.startIndividualServer('macos_tts');
            macosPort = serverManager.getServerPort('macos_tts');
            if (!macosPort) {
                throw new Error('Failed to start macOS TTS server. Please check if macOS TTS is available on your system.');
            }
            log(`[generateMacOSTTS] macOS TTS server started successfully on port ${macosPort}`);
        } catch (startError) {
            throw new Error(`macOS TTS server failed to start: ${startError}. Try switching to macOS TTS backend first or check if macOS TTS is available.`);
        }
    }
    
    log(`[generateMacOSTTS] Using macOS server on port ${macosPort} for token "${token}"`);
    
    // Quick health check to fail fast if server is not responsive
    try {
        const health = await fetch(`http://localhost:${macosPort}/health`, { method: 'GET', dispatcher: keepAliveAgent, signal: AbortSignal.timeout(2000) });
        if (!health.ok) {
            log(`[generateMacOSTTS] Health check failed: ${health.status} ${health.statusText}`);
        }
    } catch (e) {
        log(`[generateMacOSTTS] Health check error: ${e}`);
    }

    // Post with timeout and one retry on transient errors
    const postOnce = async () => fetch(`http://localhost:${macosPort}/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            text: token,
            voice: macosSettings.defaultVoice,
            rate: macosSettings.rate,
            volume: macosSettings.volume,
            sample_rate: macosSettings.sampleRate,
        }),
        dispatcher: keepAliveAgent,
        signal: AbortSignal.timeout(5000)
    });

    let res: UndiciResponse;
    try {
        res = await postOnce();
    } catch (e) {
        log(`[generateMacOSTTS] First fetch failed, retrying once: ${e}`);
        res = await postOnce();
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
            `[generateMacOSTTS] TTS server error ${res.status} ${res.statusText}: ${errorBody}`
        );
        throw new Error(`macOS TTS server error: ${res.status} ${res.statusText}. Server may not be running.`);
    }
    return Buffer.from(await res.arrayBuffer());
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
    } else if (currentBackend === TTSBackend.Espeak) {
        // For pure Espeak backend, use Espeak voices for all languages
        const categorySettings = (baseCategory && espeakCategoryVoiceMap[baseCategory]) || {};
        const espeakSettings = { ...espeakConfig, ...categorySettings };
        const voice = espeakSettings.defaultVoice;
        if (category?.includes('comment')) {
            log(`[getSpeakerForCategory] Returning Espeak voice for comment (Pure Espeak): ${voice}`);
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
    } else if (currentBackend === TTSBackend.MacOSGPT || currentBackend === TTSBackend.MacOS) {
        // For macOS backends, use macOS voices for English, OpenAI for Korean (in MacOSGPT)
        const categorySettings = (baseCategory && macosCategoryVoiceMap[baseCategory]) || {};
        const macosSettings = { ...macosConfig, ...categorySettings };
        const voice = macosSettings.defaultVoice;
        if (category?.includes('comment')) {
            log(`[getSpeakerForCategory] Returning macOS voice for comment: ${voice}`);
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