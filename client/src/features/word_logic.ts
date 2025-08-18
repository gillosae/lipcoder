import * as fs from 'fs';
import { log } from '../utils';
import { twoLenExceptions, threeLenExceptions } from '../mapping';
import { containsKorean, detectLanguage, DetectedLanguage } from '../language_detection';

// Dictionary loading
let dictWords: Set<string> = new Set();
let wordListPath: string;

export async function loadDictionaryWord() {
    const pkg = await import('word-list');
    wordListPath = pkg.default;
    const data = fs.readFileSync(wordListPath, 'utf8');
    dictWords = new Set(data.split('\n').map(w => w.toLowerCase()));
}

export function isDictionaryWord(token: string): boolean {
    return dictWords.has(token.toLowerCase());
}

/**
 * Check if text contains Korean characters
 */
function isKoreanText(text: string): boolean {
    return containsKorean(text);
}

/**
 * Split Korean text into meaningful chunks
 * Korean text should generally be kept as whole words/phrases
 */
function splitKoreanText(text: string): string[] {
    // For Korean text, we want to keep words together
    // Split on whitespace and punctuation, but keep Korean characters together
    const result: string[] = [];
    let currentKoreanWord = '';
    
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        
        if (containsKorean(char)) {
            // Korean character - add to current word
            currentKoreanWord += char;
        } else if (/\s/.test(char)) {
            // Whitespace - end current Korean word if any
            if (currentKoreanWord) {
                result.push(currentKoreanWord);
                currentKoreanWord = '';
            }
            // Skip whitespace
        } else {
            // Non-Korean, non-whitespace character (punctuation, numbers, etc.)
            if (currentKoreanWord) {
                result.push(currentKoreanWord);
                currentKoreanWord = '';
            }
            result.push(char);
        }
    }
    
    // Add final Korean word if any
    if (currentKoreanWord) {
        result.push(currentKoreanWord);
    }
    
    return result.filter(Boolean);
}

// Helper to split a CamelCase identifier
export function isCamelCase(id: string) {
    return /[a-z][A-Z]/.test(id);
}
export function splitCamel(id: string): string[] {
    return id.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])/g) || [id];
}


/**
 * Split input text into tokens:
 * 1. Check if text contains Korean - if so, use Korean-specific splitting
 * 2. For English text: Split on whitespace and handle English word logic
 * 3. For letter runs of length 2, if in exceptions, keep whole;
 *    For letter runs of length 3, if in dictionary and not in exceptions, keep whole;
 *    otherwise split into individual letters.
 * 4. Digit runs and special runs are split into individual characters.
 */
export function splitWordChunks(text: string): string[] {
    // Check if text contains Korean characters
    if (isKoreanText(text)) {
        log(`[splitWordChunks] Korean text detected, using Korean tokenization: "${text}"`);
        return splitKoreanText(text);
    }
    
    const result: string[] = [];
    // 1. Split on whitespace
    const chunks = text.split(/\s+/).filter(Boolean);

    for (const chunk of chunks) {
        // Check if this chunk contains Korean
        if (isKoreanText(chunk)) {
            // Handle Korean chunk
            const koreanTokens = splitKoreanText(chunk);
            result.push(...koreanTokens);
            continue;
        }
        
        // 2. Handle camelCase by splitting first (English text)
        const subChunks = isCamelCase(chunk) ? splitCamel(chunk) : [chunk];

        for (const sub of subChunks) {
            // 2. Further split on runs of letters, digits, underscores (one at a time), or non-alphanumerics
            const runs = sub.match(/[A-Za-z]+|\d+|_|[^\w\s]/g);
            if (!runs) continue;

            for (const run of runs) {
                if (/^[A-Za-z]+$/.test(run)) {
                    const lower = run.toLowerCase();
                    // 3. Letter runs of length 2
                    if (run.length === 2) {
                        if (twoLenExceptions.has(lower)) {
                            result.push(run);
                        } else {
                            for (const ch of run) result.push(ch);
                        }
                    }
                    // 3. Letter runs of length 3
                    else if (run.length === 3) {
                        if (isDictionaryWord(lower) && !threeLenExceptions.has(lower)) {
                            result.push(run);
                        } else {
                            for (const ch of run) result.push(ch);
                        }
                    }
                    // 3. All other letter runs: keep whole
                    else {
                        result.push(run);
                    }
                } else {
                    // 4. Digit runs and special runs: split into individual characters
                    for (const ch of run) result.push(ch);
                }
            }
        }
    }

    // log(`[splitWordChunks] input="${text}" → tokens=${JSON.stringify(result)}`);
    return result;
}

/**
 * Handle comment text specially - now simplified to keep entire comment as single unit
 * for direct TTS processing with language detection and special character handling.
 */
export function splitCommentChunks(text: string, category: string): string[] {
    // For comment text, keep the entire text as a single unit for direct TTS
    // The TTS system will handle language detection and special characters internally
    if (category === 'comment_text') {
        return [text];
    }
    
    // For whitespace, keep as is
    if (category === 'whitespace') {
        return [text];
    }
    
    // For other categories, keep as single token
    return [text];
}