import { log } from './utils';

/**
 * Language detection utilities for TTS routing
 */

export enum DetectedLanguage {
    English = 'en',
    Korean = 'ko',
    Mixed = 'mixed',
    Unknown = 'unknown'
}

/**
 * Detect if text contains Korean characters (optimized for alphabet performance)
 */
export function containsKorean(text: string): boolean {
    // ULTRA-FAST pre-check for single ASCII letters (common case for alphabet)
    if (text.length === 1) {
        const charCode = text.charCodeAt(0);
        // ASCII letters (A-Z, a-z) - definitely not Korean
        if ((charCode >= 65 && charCode <= 90) || (charCode >= 97 && charCode <= 122)) {
            return false;
        }
        // ASCII digits and common symbols - definitely not Korean
        if (charCode >= 32 && charCode <= 126) {
            return false;
        }
    }
    
    // Fast pre-check: if text is short and only contains ASCII, skip regex
    if (text.length <= 3 && /^[\x00-\x7F]*$/.test(text)) {
        return false;
    }
    
    // Korean Unicode ranges:
    // Hangul Syllables: U+AC00-U+D7AF
    // Hangul Jamo: U+1100-U+11FF
    // Hangul Compatibility Jamo: U+3130-U+318F
    // Hangul Jamo Extended-A: U+A960-U+A97F
    // Hangul Jamo Extended-B: U+D7B0-U+D7FF
    const koreanRegex = /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F\uA960-\uA97F\uD7B0-\uD7FF]/;
    return koreanRegex.test(text);
}

/**
 * Detect if text contains English characters (letters and common punctuation)
 */
export function containsEnglish(text: string): boolean {
    // Basic Latin characters (A-Z, a-z) and common punctuation
    const englishRegex = /[A-Za-z]/;
    return englishRegex.test(text);
}

/**
 * Count Korean characters in text
 */
export function countKoreanChars(text: string): number {
    const koreanRegex = /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F\uA960-\uA97F\uD7B0-\uD7FF]/g;
    const matches = text.match(koreanRegex);
    return matches ? matches.length : 0;
}

/**
 * Count English characters in text
 */
export function countEnglishChars(text: string): number {
    const englishRegex = /[A-Za-z]/g;
    const matches = text.match(englishRegex);
    return matches ? matches.length : 0;
}

// Language detection cache to avoid repeated regex operations
const languageCache = new Map<string, DetectedLanguage>();
const CACHE_MAX_SIZE = 1000;

/**
 * Detect the primary language of a text string with caching (optimized for alphabet)
 */
export function detectLanguage(text: string): DetectedLanguage {
    if (!text || text.trim().length === 0) {
        return DetectedLanguage.Unknown;
    }
    
    // OPTIMIZATION: Skip caching for single ASCII characters (alphabet/digits/symbols)
    // This avoids cache overhead for the most common case
    if (text.length === 1) {
        const charCode = text.charCodeAt(0);
        // ASCII letters, digits, and symbols - definitely English
        if (charCode >= 32 && charCode <= 126) {
            return DetectedLanguage.English;
        }
    }
    
    // Check cache for longer strings
    const cached = languageCache.get(text);
    if (cached !== undefined) {
        return cached;
    }
    
    const hasKorean = containsKorean(text);
    const hasEnglish = containsEnglish(text);
    
    let result: DetectedLanguage;
    
    // If both languages are present, determine which is dominant
    if (hasKorean && hasEnglish) {
        const koreanCount = countKoreanChars(text);
        const englishCount = countEnglishChars(text);
        
        // If Korean characters make up more than 30% of the text, consider it Korean
        const totalChars = koreanCount + englishCount;
        if (totalChars > 0) {
            const koreanRatio = koreanCount / totalChars;
            if (koreanRatio > 0.3) {
                log(`[detectLanguage] Mixed text detected, Korean dominant (${(koreanRatio * 100).toFixed(1)}%): "${text.substring(0, 50)}..."`);
                result = DetectedLanguage.Korean;
            } else {
                log(`[detectLanguage] Mixed text detected, English dominant (${((1 - koreanRatio) * 100).toFixed(1)}%): "${text.substring(0, 50)}..."`);
                result = DetectedLanguage.English;
            }
        } else {
            result = DetectedLanguage.Mixed;
        }
    }
    // Single language detection
    else if (hasKorean) {
        log(`[detectLanguage] Korean detected: "${text.substring(0, 50)}..."`);
        result = DetectedLanguage.Korean;
    }
    else if (hasEnglish) {
        log(`[detectLanguage] English detected: "${text.substring(0, 50)}..."`);
        result = DetectedLanguage.English;
    }
    // If no letters detected, check for numbers and symbols
    // Default to English for programming symbols, numbers, etc.
    else if (/[\d\s\p{P}\p{S}]/u.test(text)) {
        log(`[detectLanguage] Numbers/symbols detected, defaulting to English: "${text.substring(0, 50)}..."`);
        result = DetectedLanguage.English;
    }
    else {
        log(`[detectLanguage] Unknown language: "${text.substring(0, 50)}..."`);
        result = DetectedLanguage.Unknown;
    }
    
    // Cache the result with size limit
    if (languageCache.size >= CACHE_MAX_SIZE) {
        // Remove oldest entries (simple FIFO)
        const firstKey = languageCache.keys().next().value;
        if (firstKey !== undefined) {
            languageCache.delete(firstKey);
        }
    }
    languageCache.set(text, result);
    
    return result;
}

/**
 * Split mixed-language text into segments by language
 * Returns array of {text, language} objects
 */
export function splitByLanguage(text: string): Array<{text: string, language: DetectedLanguage}> {
    const segments: Array<{text: string, language: DetectedLanguage}> = [];
    let currentSegment = '';
    let currentLanguage: DetectedLanguage | null = null;
    
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        const charLanguage = detectLanguage(char);
        
        // If this is the first character or same language as current segment
        if (currentLanguage === null || currentLanguage === charLanguage) {
            currentSegment += char;
            currentLanguage = charLanguage;
        } else {
            // Language changed, save current segment and start new one
            if (currentSegment.trim()) {
                segments.push({
                    text: currentSegment,
                    language: currentLanguage
                });
            }
            currentSegment = char;
            currentLanguage = charLanguage;
        }
    }
    
    // Add the final segment
    if (currentSegment.trim()) {
        segments.push({
            text: currentSegment,
            language: currentLanguage || DetectedLanguage.Unknown
        });
    }
    
    return segments;
}

/**
 * Check if a token should use Korean TTS based on language detection
 */
export function shouldUseKoreanTTS(token: string): boolean {
    const language = detectLanguage(token);
    return language === DetectedLanguage.Korean;
}

/**
 * Check if a token should use English TTS based on language detection
 */
export function shouldUseEnglishTTS(token: string): boolean {
    const language = detectLanguage(token);
    return language === DetectedLanguage.English || language === DetectedLanguage.Unknown;
}
