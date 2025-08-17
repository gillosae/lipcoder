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
 * Detect if text contains Korean characters
 */
export function containsKorean(text: string): boolean {
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

/**
 * Detect the primary language of a text string
 */
export function detectLanguage(text: string): DetectedLanguage {
    if (!text || text.trim().length === 0) {
        return DetectedLanguage.Unknown;
    }
    
    const hasKorean = containsKorean(text);
    const hasEnglish = containsEnglish(text);
    
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
                return DetectedLanguage.Korean;
            } else {
                log(`[detectLanguage] Mixed text detected, English dominant (${((1 - koreanRatio) * 100).toFixed(1)}%): "${text.substring(0, 50)}..."`);
                return DetectedLanguage.English;
            }
        }
        return DetectedLanguage.Mixed;
    }
    
    // Single language detection
    if (hasKorean) {
        log(`[detectLanguage] Korean detected: "${text.substring(0, 50)}..."`);
        return DetectedLanguage.Korean;
    }
    
    if (hasEnglish) {
        log(`[detectLanguage] English detected: "${text.substring(0, 50)}..."`);
        return DetectedLanguage.English;
    }
    
    // If no letters detected, check for numbers and symbols
    // Default to English for programming symbols, numbers, etc.
    if (/[\d\s\p{P}\p{S}]/u.test(text)) {
        log(`[detectLanguage] Numbers/symbols detected, defaulting to English: "${text.substring(0, 50)}..."`);
        return DetectedLanguage.English;
    }
    
    log(`[detectLanguage] Unknown language: "${text.substring(0, 50)}..."`);
    return DetectedLanguage.Unknown;
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
