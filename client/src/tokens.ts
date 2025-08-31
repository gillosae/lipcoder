import * as fs from 'fs';
import * as path from 'path';
import { config } from './config';
import { SPECIAL_CHAR_FILES, MULTI_CHAR_FILES } from './mapping';


// ── Preload Earcons into Memory ──────────────────────────────────────────────
// List every token that uses a WAV earcon:
export const earconTokens = [
    ' ', "'", '"',
    '{', '}', '<', '>', '[', ']', '(', ')',
    ';', '\\', '_',
    // Characters that have earcon files in special directory
    '+', '&', '*', '@', '`', '^', '$', '!', '%', '?', '#', '~', '₩',
    // Characters moved from TTS to PCM files for better performance
    '.', ',', ':', '-', '=', '/', '|',
    // Multi-character sequences
    '//', '<=', '>=', '==', '!=', '===', '!==', '&&', '||', '++', '--', '+=', '-=', '*=', '/=', '=>'
];

// ── Earcon lookup ─────────────────────────────────────────────────────────────
export function getTokenSound(token: string): string | null {
    if (token === ' ') {
        return path.join(config.audioPath(), 'earcon', 'space.pcm');
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
        ';': 'semicolon.pcm',
        // Underscore back to earcon for fast playback
        '_': 'underscore.pcm',
        // Removed characters that user prefers as TTS: ',', '.', ':', '-', '/'
    };
    
    // Check earcon folder first (support .pcm and .wav)
    if (map[token]) {
        const base = path.join(config.audioPath(), 'earcon', path.basename(map[token], '.pcm'));
        const pcm = `${base}.pcm`;
        const wav = `${base}.wav`;
        if (fs.existsSync(pcm)) return pcm;
        if (fs.existsSync(wav)) return wav;
    }
    
    // Check backend-specific special folder for single char tokens
    if (SPECIAL_CHAR_FILES[token]) {
        const baseName = path.basename(SPECIAL_CHAR_FILES[token], '.pcm');
        const pcm = path.join(config.specialPath(), `${baseName}.pcm`);
        const wav = path.join(config.specialPath(), `${baseName}.wav`);
        if (fs.existsSync(pcm)) {
            return pcm;
        }
        if (fs.existsSync(wav)) {
            return wav;
        }
        // Legacy fallback to old special folder
        const legacyPcm = path.join(config.audioPath(), 'special', `${baseName}.pcm`);
        const legacyWav = path.join(config.audioPath(), 'special', `${baseName}.wav`);
        console.log(`[getTokenSound] Backend-specific not found, checking legacy: legacyPcm=${legacyPcm}, exists=${fs.existsSync(legacyPcm)}`);
        if (fs.existsSync(legacyPcm)) {
            console.log(`[getTokenSound] Using LEGACY PCM: ${legacyPcm}`);
            return legacyPcm;
        }
        if (fs.existsSync(legacyWav)) {
            console.log(`[getTokenSound] Using LEGACY WAV: ${legacyWav}`);
            return legacyWav;
        }
    }
    
    // Check backend-specific special folder for multi-character sequences
    if (MULTI_CHAR_FILES[token]) {
        const baseName = path.basename(MULTI_CHAR_FILES[token], '.pcm');
        const pcm = path.join(config.specialPath(), `${baseName}.pcm`);
        const wav = path.join(config.specialPath(), `${baseName}.wav`);
        if (fs.existsSync(pcm)) return pcm;
        if (fs.existsSync(wav)) return wav;
        // Legacy fallback
        const legacyPcm = path.join(config.audioPath(), 'special', `${baseName}.pcm`);
        const legacyWav = path.join(config.audioPath(), 'special', `${baseName}.wav`);
        if (fs.existsSync(legacyPcm)) return legacyPcm;
        if (fs.existsSync(legacyWav)) return legacyWav;
    }
    
    return null;
}
export namespace getTokenSound {
    export let singleQuote: boolean;
    export let doubleQuote: boolean;
}