import * as path from 'path';
import type { ExtensionContext } from 'vscode';

// Two and three word exception mappings
export const twoLenExceptions = new Set(['no', 'is', 'if', 'on', 'in', 'to', 'by', 'of', 'as', 'at', 'or', 'up']);
export const threeLenExceptions = new Set(['fmt', 'rgb', 'str', 'png', 'jpg', 'wav', 'mp3', 'mp4', 'ogg', 'url', 'api', 'css', 'vfx', 'xml', 'jsx', 'tsx', 'ogg', 'pcm']);

const PUNCTUATION_FILES: Record<string, string> = {
    '{': 'brace.pcm', '}': 'brace2.pcm',
    '<': 'anglebracket.pcm', '>': 'anglebracket2.pcm',
    '[': 'squarebracket.pcm', ']': 'squarebracket2.pcm',
    '(': 'parenthesis.pcm', ')': 'parenthesis2.pcm',
    ',': 'comma.pcm',
    ';': 'semicolon.pcm', '/': 'slash.pcm',
    '-': 'bar.pcm', ':': 'colon.pcm',
    "'": 'quote.pcm', '"': 'bigquote.pcm',
    '_': 'underbar.pcm',
    '.': 'dot.pcm', // Added missing dot earcon
};

export const SPECIAL_CHAR_FILES: Record<string, string> = {
    '!': 'excitation.pcm', '@': 'at.pcm', '#': 'sharp.pcm', '$': 'dollar.pcm',
    '%': 'percent.pcm', '^': 'caret.pcm', '&': 'ampersand.pcm', '*': 'asterisk.pcm',
    '+': 'plus.pcm', '~': 'tilde.pcm', '|': 'bar.pcm', '?': 'question.pcm',
    '₩': 'won.pcm', '=': 'equals.pcm', '`': 'backtick.pcm', '\\': 'backslash.pcm',
};


// "fallback" spoken names for chars that need TTS (not direct PCM mappings)
export const specialCharMap: Record<string, string> = {
    // digits → word (for spelling out numbers)
    '0': 'zero', '1': 'one', '2': 'two', '3': 'three', '4': 'four',
    '5': 'five', '6': 'six', '7': 'seven', '8': 'eight', '9': 'nine',
    // letters → name (for spelling out letters)
    a: 'ay', b: 'bee', c: 'see', d: 'dee', e: 'ee', f: 'eff',
    g: 'gee', h: 'aitch', i: 'eye', j: 'jay', k: 'kay', l: 'el',
    m: 'em', n: 'en', o: 'oh', p: 'pee', q: 'cue', r: 'ar',
    s: 'ess', t: 'tee', u: 'you', v: 'vee', w: 'double you',
    x: 'ex', y: 'why', z: 'zee',
    // characters without direct PCM files (fallback TTS names)
};

// Converts numbers 0–3000 to English words
function numberToWords(num: number): string {
    const ones = [
        'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'
    ];
    const teens = [
        'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen',
        'sixteen', 'seventeen', 'eighteen', 'nineteen'
    ];
    const tens = [
        '', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'
    ];
    if (num < 10) return ones[num];
    if (num < 20) return teens[num - 10];
    if (num < 100) {
        const t = Math.floor(num / 10);
        const r = num % 10;
        return r === 0 ? tens[t] : `${tens[t]}-${ones[r]}`;
    }
    if (num < 1000) {
        const h = Math.floor(num / 100);
        const r = num % 100;
        return r === 0
            ? `${ones[h]} hundred`
            : `${ones[h]} hundred ${numberToWords(r)}`;
    }
    // 1000–3000
    const th = Math.floor(num / 1000);
    const r = num % 1000;
    return r === 0
        ? `${ones[th]} thousand`
        : `${ones[th]} thousand ${numberToWords(r)}`;
}

// Precompute mappings for 0–3000
export const numberMap: Record<string, string> = (() => {
    const map: Record<string, string> = {};
    for (let i = 0; i <= 3000; i++) {
        map[i.toString()] = numberToWords(i);
    }
    return map;
})();

function mapFiles(mapping: Record<string, string>, dir: string) {
    return Object.fromEntries(
        Object.entries(mapping).map(([k, f]) => [k, path.join(dir, f)])
    );
}

function rangeMap(start: number, end: number, dir: string) {
    return Object.fromEntries(
        Array.from({ length: end - start + 1 }, (_, i) => {
            const k = String(start + i);
            return [k, path.join(dir, `${k}.pcm`)];
        })
    );
}

function alphabetMap(dir: string) {
    return Object.fromEntries(
        Array.from({ length: 26 }, (_, i) => {
            const ch = String.fromCharCode(97 + i);
            return [ch, path.join(dir, `${ch}.pcm`)];
        })
    );
}

export function createAudioMap(ctx: ExtensionContext): Record<string, string> {
    const BASE = ctx.asAbsolutePath(path.join('client', 'audio'));
    const EARCON_DIR = path.join(BASE, 'earcon');
    const NUMBER_DIR = path.join(BASE, 'number');
    const ALPHABET_DIR = path.join(BASE, 'alphabet');
    const SPECIAL_DIR = path.join(BASE, 'special');

    const audioMap = {
        // 1) on‐disk single‐char WAVs
        ...mapFiles(PUNCTUATION_FILES, EARCON_DIR),
        ...rangeMap(0, 9, NUMBER_DIR),
        ...alphabetMap(ALPHABET_DIR),
        ' ': path.join(EARCON_DIR, 'space.pcm'),
        ...mapFiles(SPECIAL_CHAR_FILES, SPECIAL_DIR)
    };
    
    // Debug logging for underscore
    console.log(`[createAudioMap] underscore mapped to: ${(audioMap as any)['_'] || 'undefined'}`);
    
    return audioMap;
}

export function isEarcon(ch: string): boolean {
    // Single-char earcons include both punctuation and special‐char mappings
    return (
        ch.length === 1
        && (
            PUNCTUATION_FILES[ch] !== undefined
            || SPECIAL_CHAR_FILES[ch] !== undefined
        )
    );
}

export function isSpecial(ch: string): boolean {
    return ch.length === 1 && SPECIAL_CHAR_FILES[ch] !== undefined;
}

export function isAlphabet(token: string): boolean {
    return /^[A-Za-z]$/.test(token);
}

export function isNumber(token: string): boolean {
    return /^\d$/.test(token);
}