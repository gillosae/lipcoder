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
 * Split Korean text into meaningful chunks (optimized for TTS performance)
 * Korean text should generally be kept as whole phrases to reduce TTS overhead
 */
function splitKoreanText(text: string): string[] {
    // For Korean text, keep longer phrases together to reduce TTS processing overhead
    // Only split on major punctuation, not on whitespace
    const result: string[] = [];
    let currentPhrase = '';
    
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        
        // Split only on major punctuation that indicates sentence boundaries
        if (/[.!?;]/.test(char)) {
            // Major punctuation - end current phrase if any
            if (currentPhrase.trim()) {
                result.push(currentPhrase.trim());
                currentPhrase = '';
            }
            result.push(char);
        } else {
            // Keep everything else together (Korean chars, whitespace, minor punctuation)
            currentPhrase += char;
        }
    }
    
    // Add final phrase if any
    if (currentPhrase.trim()) {
        result.push(currentPhrase.trim());
    }
    
    return result.filter(Boolean);
}

// Helper to split a CamelCase identifier
export function isCamelCase(id: string) {
    return /[a-z][A-Z]/.test(id);
}
export function splitCamel(id: string): string[] {
    return id.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])|[0-9]+/g) || [id];
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
/**
 * Split mixed text into Korean, English, earcons, and Python expressions
 */
function splitMixedText(text: string): string[] {
    const result: string[] = [];
    let current = '';
    let i = 0;
    let inExpression = false;
    let braceDepth = 0;
    
    while (i < text.length) {
        const char = text[i];
        
        if (char === '{' && !inExpression) {
            // Start of f-string expression
            if (current) {
                // Process the accumulated text before the expression
                result.push(...splitTextByLanguageAndEarcons(current));
                current = '';
            }
            inExpression = true;
            braceDepth = 1;
            current = char;
        } else if (char === '{' && inExpression) {
            // Nested brace in expression
            braceDepth++;
            current += char;
        } else if (char === '}' && inExpression) {
            braceDepth--;
            current += char;
            if (braceDepth === 0) {
                // End of f-string expression - treat as English
                result.push(current);
                current = '';
                inExpression = false;
            }
        } else {
            current += char;
        }
        i++;
    }
    
    if (current) {
        if (inExpression) {
            // Unclosed expression - treat as English
            result.push(current);
        } else {
            // Regular text - split by language and earcons
            result.push(...splitTextByLanguageAndEarcons(current));
        }
    }
    
    log(`[splitMixedText] input="${text}" → parts=${JSON.stringify(result)}`);
    return result;
}

/**
 * Split text by language (Korean/English) and earcons
 */
function splitTextByLanguageAndEarcons(text: string): string[] {
    const result: string[] = [];
    let current = '';
    let currentIsKorean: boolean | null = null;
    
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        
        // Check if character is an earcon
        if (isEarconChar(char)) {
            // Flush current text
            if (current) {
                result.push(current);
                current = '';
                currentIsKorean = null;
            }
            // Add earcon as separate token
            result.push(char);
            continue;
        }
        
        // Check if character is Korean
        const charIsKorean = /[\u3131-\u3163\uac00-\ud7a3]/.test(char);
        
        if (currentIsKorean === null) {
            // First character - set the language
            currentIsKorean = charIsKorean;
            current = char;
        } else if (currentIsKorean === charIsKorean) {
            // Same language - continue accumulating
            current += char;
        } else {
            // Language change - flush current and start new
            if (current) {
                result.push(current);
            }
            current = char;
            currentIsKorean = charIsKorean;
        }
    }
    
    if (current) {
        result.push(current);
    }
    
    return result;
}

/**
 * Check if character should be treated as earcon
 */
function isEarconChar(char: string): boolean {
    // Common earcon characters
    const earconChars = new Set([
        '✓', '✗', '→', '←', '↑', '↓', '★', '☆', '♠', '♣', '♥', '♦',
        '(', ')', '[', ']', '{', '}', '<', '>',
        '"', "'", '`', ',', '.', ';', ':', '_', '=',
        '+', '&', '*', '@', '^', '$', '!', '%', '?', '#', '~', '₩',
        '-', '/', '|', '\\', '\n', '\t'
    ]);
    return earconChars.has(char);
}

export function splitWordChunks(text: string): string[] {
    // Check if this looks like mixed content (Korean + earcons + expressions)
    if (text.includes('{') && text.includes('}') || 
        (isKoreanText(text) && /[✓✗→←↑↓★☆♠♣♥♦()[\]{}<>"'`,.;:_=+&*@^$!%?#~₩\-/|\\]/.test(text))) {
        log(`[splitWordChunks] Mixed content detected, splitting by language and earcons: "${text}"`);
        const mixedParts = splitMixedText(text);
        const result: string[] = [];
        
        for (const part of mixedParts) {
            if (part.startsWith('{') && part.endsWith('}')) {
                // This is a Python expression - treat as English
                log(`[splitWordChunks] Processing Python expression: "${part}"`);
                result.push(part);
            } else if (isEarconChar(part)) {
                // This is an earcon character
                log(`[splitWordChunks] Processing earcon: "${part}"`);
                result.push(part);
            } else if (isKoreanText(part)) {
                // This is Korean text
                log(`[splitWordChunks] Processing Korean text: "${part}"`);
                const koreanTokens = splitKoreanText(part);
                result.push(...koreanTokens);
            } else {
                // This is regular English text
                log(`[splitWordChunks] Processing English text: "${part}"`);
                result.push(part);
            }
        }
        
        log(`[splitWordChunks] Mixed content result: ${JSON.stringify(result)}`);
        return result;
    }
    
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
                        if (twoLenExceptions.has(lower) || isDictionaryWord(lower)) {
                            // keep whole (avoid spelling out letters for common short words like "to", "of", etc.)
                            result.push(run);
                        } else {
                            // fallback: spell letters
                            for (const ch of run) result.push(ch);
                        }
                    }
                    // 3. Letter runs of length 3
                    else if (run.length === 3) {
                        if (threeLenExceptions.has(lower) || isDictionaryWord(lower)) {
                            // keep whole (read as a word) — covers "out", "not" even in upper-case input
                            result.push(run);
                        } else {
                            // fallback: spell letters
                            for (const ch of run) result.push(ch);
                        }
                    }
                    // 3. All other letter runs: keep whole
                    else {
                        result.push(run);
                    }
                } else if (/^\d+$/.test(run)) {
                    // 4. Digit runs: keep as complete numbers for better TTS pronunciation
                    result.push(run);
                } else {
                    // 4. Special runs: split into individual characters
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