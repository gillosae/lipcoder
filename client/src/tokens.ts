import * as fs from 'fs';
import * as path from 'path';
import { config } from './config';
import { SPECIAL_CHAR_FILES } from './mapping';


// ── Preload Earcons into Memory ──────────────────────────────────────────────
// List every token that uses a WAV earcon:
export const earconTokens = [
    ' ', "'", '"',
    '{', '}', '<', '>', '[', ']', '(', ')',
    ';', '/', '-', ':', '\\'
    // Removed: ',', '.', '_' - now handled by TTS
];

// ── Earcon lookup ─────────────────────────────────────────────────────────────
export function getTokenSound(token: string): string | null {
    if (token === ' ') {
        return path.join(config.audioPath(), 'earcon', 'space.pcm');
    }
    if (token === '\\') {
        return path.join(config.audioPath(), 'special', 'backslash.pcm');
    }
    if (getTokenSound.singleQuote === undefined) {
        getTokenSound.singleQuote = true;
        getTokenSound.doubleQuote = true;
    }
    if (token === "'") {
        const file = getTokenSound.singleQuote ? 'quote.pcm' : 'quote2.pcm';
        getTokenSound.singleQuote = !getTokenSound.singleQuote;
        return path.join(config.audioPath(), 'earcon', file);
    }
    if (token === '"') {
        const file = getTokenSound.doubleQuote ? 'bigquote.pcm' : 'bigquote2.pcm';
        getTokenSound.doubleQuote = !getTokenSound.doubleQuote;
        return path.join(config.audioPath(), 'earcon', file);
    }
    const map: Record<string, string> = {
        // Brackets and parentheses
        '{': 'brace.pcm', '}': 'brace2.pcm',
        '<': 'anglebracket.pcm', '>': 'anglebracket2.pcm',
        '[': 'squarebracket.pcm', ']': 'squarebracket2.pcm',
        '(': 'parenthesis.pcm', ')': 'parenthesis2.pcm',
        // Punctuation
        ';': 'semicolon.pcm', '/': 'slash.pcm',
        ':': 'colon.pcm', '-': 'bar.pcm',
        // Removed: ',': 'comma.pcm', '_': 'underbar.pcm', '.': 'dot.pcm' - now handled by TTS
    };
    
    // Check earcon folder first
    if (map[token]) {
        return path.join(config.audioPath(), 'earcon', map[token]);
    }
    
    // Check special folder using the imported mapping
    if (SPECIAL_CHAR_FILES[token]) {
        return path.join(config.audioPath(), 'special', SPECIAL_CHAR_FILES[token]);
    }
    
    return null;
}
export namespace getTokenSound {
    export let singleQuote: boolean;
    export let doubleQuote: boolean;
}