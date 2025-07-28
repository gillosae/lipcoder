import { config } from './config';
import * as path from 'path';


// ── Preload Earcons into Memory ──────────────────────────────────────────────
// List every token that uses a WAV earcon:
export const earconTokens = [
    ' ', "'", '"',
    '{', '}', '<', '>', '[', ']', '(', ')',
    ',', ';', '/', '.', '-', ':', '\\'
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
        '{': 'brace.pcm', '}': 'brace2.pcm',
        '<': 'anglebracket.pcm', '>': 'anglebracket2.pcm',
        '[': 'squarebracket.pcm', ']': 'squarebracket2.pcm',
        '(': 'parenthesis.pcm', ')': 'parenthesis2.pcm',
        ',': 'comma.pcm', ';': 'semicolon.pcm',
        '/': 'slash.pcm', // '_': 'underbar.pcm',
        '.': 'dot.pcm', ':': 'colon.pcm', '-': 'bar.pcm',
    };
    if (map[token]) {
        return path.join(config.audioPath(), 'earcon', map[token]);
    }
    return null;
}
export namespace getTokenSound {
    export let singleQuote: boolean;
    export let doubleQuote: boolean;
}