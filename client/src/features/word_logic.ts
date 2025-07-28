import * as fs from 'fs';
import { log } from '../utils';
import { twoLenExceptions, threeLenExceptions } from '../mapping';

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

// Helper to split a CamelCase identifier
export function isCamelCase(id: string) {
    return /[a-z][A-Z]/.test(id);
}
export function splitCamel(id: string): string[] {
    return id.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])/g) || [id];
}


/**
 * Split input text into tokens:
 * 1. Split on whitespace.
 * 2. Further split on runs of letters, digits, or non-alphanumerics, or camelCase.
 * 3. For letter runs of length 2, if in exceptions, keep whole;
 *    For letter runs of length 3, if in dictionary and not in exceptions, keep whole;
 *    otherwise split into individual letters.
 * 4. Digit runs and special runs are split into individual characters.
 */
export function splitWordChunks(text: string): string[] {
    const result: string[] = [];
    // 1. Split on whitespace
    const chunks = text.split(/\s+/).filter(Boolean);

    for (const chunk of chunks) {
        // 2. Handle camelCase by splitting first
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
                        if (isDictionaryWord(run) && !threeLenExceptions.has(lower)) {
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