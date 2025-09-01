/**
 * Hallucination Filter Utilities
 * 
 * Advanced filtering system for removing common hallucination patterns
 * from ASR (Automatic Speech Recognition) outputs, particularly from
 * Whisper-based models.
 */

import { log } from '../utils';

/**
 * Configuration for hallucination filtering
 */
export interface HallucinationFilterConfig {
    // Common phrase filtering
    enableCommonPhraseFilter: boolean;
    commonPhrases: string[];
    
    // Repetitive pattern filtering
    enableRepetitiveFilter: boolean;
    maxRepetitionRatio: number;
    minRepetitionLength: number;
    
    // Length-based filtering
    enableLengthFilter: boolean;
    minTextLength: number;
    maxTextLength: number;
    
    // Special character filtering
    enableSpecialCharFilter: boolean;
    maxSpecialCharRatio: number;
    
    // Language-specific filtering
    enableLanguageFilter: boolean;
    targetLanguages: string[];
    
    // Debug logging
    enableDebugLogging: boolean;
}

/**
 * Default hallucination filter configuration
 */
export const DEFAULT_HALLUCINATION_CONFIG: HallucinationFilterConfig = {
    enableCommonPhraseFilter: true,
    commonPhrases: [
        // Korean common hallucinations
        "자막은 설정에서 선택하실 수 있습니다",
        "구독과 좋아요 부탁드립니다",
        "시청해주셔서 감사합니다",
        "다음 영상에서 만나요",
        "좋아요와 구독 부탁드려요",
        "MBC 뉴스 김지경입니다.",
        
        "구독과 좋아요 부탁드립니다",
        "구독 좋아요 부탁드립니다", 
        "자막은 설정에서 선택하실 수 있습니다",
        "자막은 설정에서 선택하실수있습니다",
        "자막은 설정에서 선택하실 수가 있습니다",
        "시청해주셔서 감사합니다",
        "시청해 주셔서 감사합니다",
        "감사합니다",
        "안녕하세요",
        "여러분 안녕하세요",
        "다음 영상에서 만나요",
        "좋아요와 구독 부탁드려요",
        "MBC 뉴스 김지경입니다.",
        "구독 좋아요 부탁드립니다", 
        "자막은 설정에서 선택하실 수 있습니다",
        "자막은 설정에서 선택하실수있습니다",
        "자막은 설정에서 선택하실 수가 있습니다",
        "시청해주셔서 감사합니다",
        "시청해 주셔서 감사합니다",
        "감사합니다",
        "안녕하세요",
        "여러분 안녕하세요",
        
        // English common hallucinations
        "Thank you for watching",
        "Please like and subscribe",
        "Don't forget to hit the bell",
        "See you in the next video",
        "Thanks for your attention",
        "Please subscribe to my channel",
        
        // Japanese common hallucinations
        "字幕をオンにしてください",
        "チャンネル登録お願いします",
        "高評価お願いします",
        "ご視聴ありがとうございました",
        "次回もお楽しみに",
        
        // Generic patterns
        "음악",
        "박수",
        "웃음",
        "Music",
        "Applause",
        "Laughter",
        "[음악]",
        "[박수]",
        "[웃음]",
        "[Music]",
        "[Applause]",
        "[Laughter]"
    ],
    
    enableRepetitiveFilter: true,
    maxRepetitionRatio: 0.8,      // 80% repetition threshold (more lenient)
    minRepetitionLength: 5,       // Minimum 5 characters to consider repetition
    
    enableLengthFilter: true,
    minTextLength: 2,             // Minimum 2 characters
    maxTextLength: 1000,          // Maximum 1000 characters
    
    enableSpecialCharFilter: true,
    maxSpecialCharRatio: 0.5,     // 50% special characters threshold
    
    enableLanguageFilter: false,   // Disabled by default
    targetLanguages: ['ko', 'en'],
    
    enableDebugLogging: false
};

/**
 * Create a lenient hallucination filter configuration
 */
export function createLenientHallucinationConfig(): HallucinationFilterConfig {
    return {
        ...DEFAULT_HALLUCINATION_CONFIG,
        maxRepetitionRatio: 0.8,      // More lenient repetition threshold
        minTextLength: 1,             // Accept single characters
        maxSpecialCharRatio: 0.7,     // More lenient special char threshold
        enableDebugLogging: true
    };
}

/**
 * Create a strict hallucination filter configuration
 */
export function createStrictHallucinationConfig(): HallucinationFilterConfig {
    return {
        ...DEFAULT_HALLUCINATION_CONFIG,
        maxRepetitionRatio: 0.3,      // Stricter repetition threshold
        minTextLength: 5,             // Require at least 5 characters
        maxSpecialCharRatio: 0.2,     // Stricter special char threshold
        enableLanguageFilter: true,   // Enable language filtering
        enableDebugLogging: true
    };
}

/**
 * Filter out common hallucination patterns from ASR output
 * 
 * @param text - The transcribed text to filter
 * @param config - Hallucination filter configuration (optional)
 * @param logPrefix - Prefix for log messages (optional)
 * @returns Filtered text or empty string if text is considered hallucination
 */
export function filterHallucinations(
    text: string, 
    config: Partial<HallucinationFilterConfig> = {},
    logPrefix: string = '[Hallucination-Filter]'
): string {
    if (!text || !text.trim()) {
        return "";
    }
    
    // Merge with default config
    const filterConfig: HallucinationFilterConfig = { ...DEFAULT_HALLUCINATION_CONFIG, ...config };
    
    const originalText = text;
    const trimmedText = text.trim();
    
    if (filterConfig.enableDebugLogging) {
        log(`${logPrefix} Processing text: "${trimmedText}"`);
    }
    
    // 1. Common phrase filtering
    if (filterConfig.enableCommonPhraseFilter) {
        for (const phrase of filterConfig.commonPhrases) {
            if (trimmedText.includes(phrase)) {
                if (filterConfig.enableDebugLogging) {
                    log(`${logPrefix} ❌ Filtered common phrase: "${phrase}"`);
                }
                return "";
            }
        }
    }
    
    // 2. Length-based filtering
    if (filterConfig.enableLengthFilter) {
        if (trimmedText.length < filterConfig.minTextLength) {
            if (filterConfig.enableDebugLogging) {
                log(`${logPrefix} ❌ Filtered too short: ${trimmedText.length} < ${filterConfig.minTextLength}`);
            }
            return "";
        }
        
        if (trimmedText.length > filterConfig.maxTextLength) {
            if (filterConfig.enableDebugLogging) {
                log(`${logPrefix} ❌ Filtered too long: ${trimmedText.length} > ${filterConfig.maxTextLength}`);
            }
            return "";
        }
    }
    
    // 3. Repetitive pattern filtering
    if (filterConfig.enableRepetitiveFilter) {
        const words = trimmedText.split(' ');
        if (words.length > 1) {
            const wordCounts = new Map<string, number>();
            let totalWords = 0;
            
            for (const word of words) {
                if (word.length >= filterConfig.minRepetitionLength) {
                    wordCounts.set(word, (wordCounts.get(word) || 0) + 1);
                    totalWords++;
                }
            }
            
            if (totalWords > 0) {
                let maxRepetitions = 0;
                for (const count of wordCounts.values()) {
                    maxRepetitions = Math.max(maxRepetitions, count);
                }
                
                const repetitionRatio = maxRepetitions / totalWords;
                if (repetitionRatio > filterConfig.maxRepetitionRatio) {
                    if (filterConfig.enableDebugLogging) {
                        log(`${logPrefix} ❌ Filtered repetitive pattern: ratio=${repetitionRatio.toFixed(2)} > ${filterConfig.maxRepetitionRatio}`);
                    }
                    return "";
                }
            }
        }
        
        // Check for character-level repetition
        const chars = trimmedText.replace(/\s+/g, '');
        if (chars.length > 0) {
            const charCounts = new Map<string, number>();
            for (const char of chars) {
                charCounts.set(char, (charCounts.get(char) || 0) + 1);
            }
            
            let maxCharRepetitions = 0;
            for (const count of charCounts.values()) {
                maxCharRepetitions = Math.max(maxCharRepetitions, count);
            }
            
            const charRepetitionRatio = maxCharRepetitions / chars.length;
            if (charRepetitionRatio > filterConfig.maxRepetitionRatio) {
                if (filterConfig.enableDebugLogging) {
                    log(`${logPrefix} ❌ Filtered character repetition: ratio=${charRepetitionRatio.toFixed(2)} > ${filterConfig.maxRepetitionRatio}`);
                }
                return "";
            }
        }
    }
    
    // 4. Special character filtering
    if (filterConfig.enableSpecialCharFilter) {
        const specialChars = trimmedText.match(/[^\w\s가-힣]/g) || [];
        const specialCharRatio = specialChars.length / trimmedText.length;
        
        if (specialCharRatio > filterConfig.maxSpecialCharRatio) {
            if (filterConfig.enableDebugLogging) {
                log(`${logPrefix} ❌ Filtered too many special chars: ratio=${specialCharRatio.toFixed(2)} > ${filterConfig.maxSpecialCharRatio}`);
            }
            return "";
        }
    }
    
    // 5. Language-specific filtering (basic implementation)
    if (filterConfig.enableLanguageFilter) {
        const hasKorean = /[가-힣]/.test(trimmedText);
        const hasEnglish = /[a-zA-Z]/.test(trimmedText);
        const hasNumbers = /[0-9]/.test(trimmedText);
        
        if (!hasKorean && !hasEnglish && !hasNumbers) {
            if (filterConfig.enableDebugLogging) {
                log(`${logPrefix} ❌ Filtered unknown language/script`);
            }
            return "";
        }
    }
    
    if (filterConfig.enableDebugLogging) {
        log(`${logPrefix} ✅ Text passed all filters: "${trimmedText}"`);
    }
    
    return trimmedText;
}

/**
 * Batch filter multiple transcription results
 * 
 * @param texts - Array of transcribed texts to filter
 * @param config - Hallucination filter configuration (optional)
 * @param logPrefix - Prefix for log messages (optional)
 * @returns Array of filtered texts (empty strings for filtered out texts)
 */
export function batchFilterHallucinations(
    texts: string[], 
    config: Partial<HallucinationFilterConfig> = {},
    logPrefix: string = '[Batch-Hallucination-Filter]'
): string[] {
    return texts.map((text, index) => {
        const filtered = filterHallucinations(text, config, `${logPrefix}[${index}]`);
        return filtered;
    });
}

/**
 * Get statistics about filtering results
 * 
 * @param originalTexts - Original texts before filtering
 * @param filteredTexts - Texts after filtering
 * @returns Statistics object
 */
export function getFilteringStats(originalTexts: string[], filteredTexts: string[]): {
    total: number;
    filtered: number;
    passed: number;
    filterRate: number;
} {
    const total = originalTexts.length;
    const filtered = filteredTexts.filter(text => text === "").length;
    const passed = total - filtered;
    const filterRate = total > 0 ? filtered / total : 0;
    
    return {
        total,
        filtered,
        passed,
        filterRate
    };
}
