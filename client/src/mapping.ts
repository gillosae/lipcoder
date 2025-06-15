// client/src/audiomap.ts
import * as path from 'path';
import type { ExtensionContext } from 'vscode';

const PUNCTUATION_FILES: Record<string, string> = {
    '{': 'brace.wav', '}': 'brace2.wav',
    '<': 'anglebracket.wav', '>': 'anglebracket2.wav',
    '[': 'squarebracket.wav', ']': 'squarebracket2.wav',
    '(': 'parenthesis.wav', ')': 'parenthesis2.wav',
    ',': 'comma.wav',
    ';': 'semicolon.wav', '/': 'slash.wav',
    '-': 'bar.wav', ':': 'colon.wav',
    "'": 'quote.wav', '"': 'bigquote.wav',
};

const SPECIAL_TOKENS: Record<string, string> = {
    ampersand: 'ampersand.wav', asterisk: 'asterisk.wav',
    at: 'at.wav', backslash: 'backslash.wav',
    backtick: 'backtick.wav', bar: 'bar.wav',
    caret: 'caret.wav', comma: 'comma.wav',
    dot: 'dot.wav', dollar: 'dollar.wav',
    equals: 'equals.wav', excitation: 'excitation.wav',
    percent: 'percent.wav', plus: 'plus.wav',
    question: 'question.wav', sharp: 'sharp.wav',
    tilde: 'tilde.wav', underbar: 'underbar.wav',
    won: 'won.wav',
};

// “fallback” spoken names for any single‐char not on disk
export const specialCharMap: Record<string, string> = {
    // punctuation → word
    '!': 'excitation', '@': 'at', '#': 'sharp', '$': 'dollar',
    '%': 'percent', '^': 'caret', '&': 'ampersand', '*': 'asterisk',
    '+': 'plus', '~': 'tilde', '|': 'bar', '?': 'question',
    '₩': 'won', '=': 'equals', '`': 'backtick', '\\': 'backslash',
    '.': 'dot', ',': 'comma', '_': 'underbar',
    // digits → word
    '0': 'zero', '1': 'one', '2': 'two', '3': 'three', '4': 'four',
    '5': 'five', '6': 'six', '7': 'seven', '8': 'eight', '9': 'nine',
    // letters → name
    a: 'ay', b: 'bee', c: 'see', d: 'dee', e: 'ee', f: 'eff',
    g: 'gee', h: 'aitch', i: 'eye', j: 'jay', k: 'kay', l: 'el',
    m: 'em', n: 'en', o: 'oh', p: 'pee', q: 'cue', r: 'ar',
    s: 'ess', t: 'tee', u: 'you', v: 'vee', w: 'double you',
    x: 'ex', y: 'why', z: 'zee',
};

function mapFiles(mapping: Record<string, string>, dir: string) {
    return Object.fromEntries(
        Object.entries(mapping).map(([k, f]) => [k, path.join(dir, f)])
    );
}

function rangeMap(start: number, end: number, dir: string) {
    return Object.fromEntries(
        Array.from({ length: end - start + 1 }, (_, i) => {
            const k = String(start + i);
            return [k, path.join(dir, `${k}.wav`)];
        })
    );
}

function alphabetMap(dir: string) {
    return Object.fromEntries(
        Array.from({ length: 26 }, (_, i) => {
            const ch = String.fromCharCode(97 + i);
            return [ch, path.join(dir, `${ch}.wav`)];
        })
    );
}

export function createAudioMap(ctx: ExtensionContext): Record<string, string> {
    const BASE = ctx.asAbsolutePath(path.join('client', 'audio'));
    const EARCON_DIR = path.join(BASE, 'earcon');
    const NUMBER_DIR = path.join(BASE, 'number');
    const ALPHABET_DIR = path.join(BASE, 'alphabet');
    const SPECIAL_DIR = path.join(BASE, 'special');

    return {
        // 1) on‐disk single‐char WAVs
        ...mapFiles(PUNCTUATION_FILES, EARCON_DIR),
        ...rangeMap(0, 9, NUMBER_DIR),
        ...alphabetMap(ALPHABET_DIR),
        ' ': path.join(EARCON_DIR, 'space.wav'),
        ...mapFiles(SPECIAL_TOKENS, SPECIAL_DIR)
    };
}