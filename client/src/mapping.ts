/**
 * Character and token mapping utilities for audio generation
 */

// Special character to audio file mapping
export const SPECIAL_CHAR_FILES: Record<string, string> = {
    '!': 'excitation.pcm', '@': 'at.pcm', '#': 'sharp.pcm', '$': 'dollar.pcm',
    '%': 'percent.pcm', '^': 'caret.pcm', '&': 'ampersand.pcm', '*': 'asterisk.pcm',
    '+': 'plus.pcm', '~': 'tilde.pcm', '|': 'bar.pcm', '?': 'question.pcm',
    '₩': 'won.pcm', '=': 'equals.pcm', '`': 'backtick.pcm', '\\': 'backslash.pcm',
    '-': 'dash.pcm', '/': 'slash.pcm', ':': 'colon.pcm', ';': 'semicolon.pcm',
    ',': 'comma.pcm', '.': 'dot.pcm', '_': 'underbar.pcm', ' ': 'space.pcm'
};

// Multi-character operators and symbols
export const MULTI_CHAR_FILES: Record<string, string> = {
    '++': 'plus_plus.pcm',
    '--': 'minus_minus.pcm',
    '+=': 'plus_equals.pcm',
    '-=': 'minus_equals.pcm',
    '*=': 'times_equals.pcm',
    '/=': 'divide_equals.pcm',
    '==': 'equals_equals.pcm',
    '!=': 'not_equal.pcm',
    '===': 'triple_equals.pcm',
    '!==': 'not_triple_equals.pcm',
    '<=': 'less_than_or_equal.pcm',
    '>=': 'greater_than_or_equal.pcm',
    '&&': 'and_and.pcm',
    '||': 'or_or.pcm',
    '//': 'slash_slash.pcm',
    '=>': 'arrow.pcm'
};

// Number to spoken form mapping
export const numberMap: Record<string, string> = {
    '0': 'zero', '1': 'one', '2': 'two', '3': 'three', '4': 'four',
    '5': 'five', '6': 'six', '7': 'seven', '8': 'eight', '9': 'nine'
};

// Earcon characters (punctuation that should use earcons instead of TTS)
const EARCON_CHARS = new Set([
    '(', ')', '[', ']', '{', '}', '<', '>',
    '"', "'", '`', ',', '.', ';', ':', 
    ' ', '\t', '\n'
]);

// Two-character exceptions for word splitting
export const twoLenExceptions = new Set([
    'if', 'is', 'in', 'or', 'on', 'at', 'to', 'be', 'do', 'go', 'no', 'so',
    'up', 'us', 'we', 'me', 'my', 'by', 'an', 'as', 'of', 'it', 'he', 'hi'
]);

// Three-character exceptions for word splitting
export const threeLenExceptions = new Set([
    'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had',
    'her', 'was', 'one', 'our', 'out', 'day', 'get', 'has', 'him', 'his',
    'how', 'man', 'new', 'now', 'old', 'see', 'two', 'way', 'who', 'boy',
    'did', 'its', 'let', 'put', 'say', 'she', 'too', 'use', 'try', 'run',
    'may', 'ask', 'own', 'end', 'why', 'add', 'big', 'got', 'lot', 'off',
    'set', 'top', 'yet', 'few', 'far', 'car', 'cut', 'eat', 'job', 'key',
    'law', 'map', 'pay', 'red', 'sit', 'win', 'yes', 'age', 'bad', 'box',
    'buy', 'eye', 'fly', 'fun', 'gun', 'hit', 'hot', 'ice', 'kid', 'lie',
    'mix', 'oil', 'pop', 'row', 'sea', 'sky', 'tax', 'tea', 'tie', 'war'
]);

/**
 * Check if a character is alphabetic
 */
export function isAlphabet(char: string): boolean {
    return /^[a-zA-Z]$/.test(char);
}

/**
 * Check if a character is numeric
 */
export function isNumber(char: string): boolean {
    return /^[0-9]$/.test(char);
}

/**
 * Check if a character should use earcon audio
 */
export function isEarcon(char: string): boolean {
    return EARCON_CHARS.has(char);
}

/**
 * Get the spoken form of a special character
 */
export function getSpecialCharSpoken(char: string): string | null {
    // Check multi-character operators first
    if (MULTI_CHAR_FILES[char]) {
        return char; // Return the operator itself for multi-char
    }
    
    // Check single character mappings
    if (SPECIAL_CHAR_FILES[char]) {
        return char; // Return the character itself
    }
    
    // Special cases for common characters
    switch (char) {
        case ' ': return 'space';
        case '\t': return 'tab';
        case '\n': return 'newline';
        case '\r': return 'return';
        default: return null;
    }
}

/**
 * Create audio mapping for preloading
 */
export function createAudioMap(context?: any): Map<string, string> {
    const audioMap = new Map<string, string>();
    
    // Add special characters
    for (const [char, file] of Object.entries(SPECIAL_CHAR_FILES)) {
        audioMap.set(char, file);
    }
    
    // Add multi-character operators
    for (const [op, file] of Object.entries(MULTI_CHAR_FILES)) {
        audioMap.set(op, file);
    }
    
    // Add numbers
    for (let i = 0; i <= 9; i++) {
        audioMap.set(i.toString(), `${i}.pcm`);
    }
    
    // Add alphabet
    for (let i = 0; i < 26; i++) {
        const letter = String.fromCharCode(97 + i); // a-z
        audioMap.set(letter, `${letter}.pcm`);
        audioMap.set(letter.toUpperCase(), `${letter}.pcm`);
    }
    
    // Add underscore for the extension check
    audioMap.set('_', 'underbar.pcm');
    
    return audioMap;
}
