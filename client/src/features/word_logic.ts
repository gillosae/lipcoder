import * as fs from 'fs';

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

export const twoLenExceptions = new Set(['no', 'is', 'if', 'on', 'in', 'to', 'by']);
export const threeLenExceptions = new Set(['fmt', 'rgb', 'str']);

/**
 * Split input text into tokens:
 * 1. Split on whitespace.
 * 2. Further split on runs of letters, digits, or non-alphanumerics.
 * 3. For letter runs of length 2–4, if in dictionary and not in exceptions, keep whole;
 *    otherwise split into individual letters.
 * 4. Digit runs and special runs are split into individual characters.
 */
export function splitWordChunks(text: string): string[] {
    const result: string[] = [];
    const chunks = text.split(/\s+/).filter(Boolean);

    for (const chunk of chunks) {
        const runs = chunk.match(/[A-Za-z]+|\d+|[^\w\s]+/g);
        if (!runs) continue;

        for (const run of runs) {
            if (/^[A-Za-z]+$/.test(run)) {
                const lower = run.toLowerCase();
                if (
                    run.length >= 2 &&
                    run.length <= 4 &&
                    isDictionaryWord(run) &&
                    !(run.length === 2 && twoLenExceptions.has(lower)) &&
                    !(run.length === 3 && threeLenExceptions.has(lower))
                ) {
                    result.push(run);
                } else if (run.length === 1) {
                    result.push(run);
                } else {
                    // split into letters
                    for (const ch of run) result.push(ch);
                }
            } else {
                // split digits or punctuation into individual chars
                for (const ch of run) result.push(ch);
            }
        }
    }

    return result;
}