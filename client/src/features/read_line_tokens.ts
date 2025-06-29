import * as fs from 'fs';
import type { ExtensionContext } from 'vscode';
import * as vscode from 'vscode';
import { log } from '../utils';
import { LanguageClient } from 'vscode-languageclient/node';
import { isEarcon, isSpecial } from '../mapping';
import { delay } from '../utils';
import { config } from '../config';
import { lipcoderLog } from '../logger';
import { specialCharMap } from '../mapping';
import { genTokenAudio, playWave, playSequence } from '../audio';

let wordListPath: string;
let dictWords: Set<string> = new Set<string>();


export async function loadDictionaryWord() {
    // Dynamically import the ESM word‐list package
    const pkg = await import('word-list');
    wordListPath = pkg.default;
    // Load dictionary into a Set for fast lookups
    dictWords = new Set<string>(
        fs.readFileSync(wordListPath, 'utf8')
            .split('\n')
            .map(w => w.toLowerCase())
    );
}

function isDictionaryWord(token: string): boolean {
    return dictWords.has(token.toLowerCase());
}

// Helper to split a CamelCase identifier
function isCamelCase(id: string) {
    return /[a-z][A-Z]/.test(id);
}
function splitCamel(id: string): string[] {
    return id.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])/g) || [id];
}

export function registerReadLineTokens(context: ExtensionContext, client: LanguageClient, currentAbortController: AbortController | null, audioMap: Record<string, string>) {
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.readLineTokens', async () => {
            // cancel any previous speech
            if (currentAbortController) {
                currentAbortController.abort();
            }
            const controller = new AbortController();
            currentAbortController = controller;
            const { signal } = controller;

            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('No active editor!');
                return;
            }
            const uri = editor.document.uri.toString();
            const line = editor.selection.active.line;

            try {
                // 1) Fetch raw tokens from LSP
                let tokens = await client.sendRequest<
                    { text: string; category: string }[]
                >('lipcoder/readLineTokens', { uri, line });
                vscode.window.showInformationMessage(
                    `Read ${tokens.length} tokens from LSP`
                );

                // Remove leading whitespace-only tokens (e.g. space, tab)
                while (tokens.length > 0 && /^\s+$/.test(tokens[0].text)) {
                    tokens.shift();
                }

                // Determine file language for keyword audio
                const docLang = editor.document.languageId === 'python' ? 'python' : 'typescript';
                tokens = tokens.map(tok => ({
                    text: tok.text,
                    category: tok.category === 'keyword' ? `keyword_${docLang}` : tok.category
                }));

                // ── Merge any [word] "_" [word] sequences back into a single token ─────────
                const mergedTokens: typeof tokens = [];
                for (let i = 0; i < tokens.length; i++) {
                    const cur = tokens[i];
                    if (
                        cur.text === '_' &&
                        mergedTokens.length > 0 &&
                        i + 1 < tokens.length &&
                        /^[A-Za-z]+$/.test(mergedTokens[mergedTokens.length - 1].text) &&
                        /^[A-Za-z]+$/.test(tokens[i + 1].text)
                    ) {
                        // pull off the last “word” token,
                        // glue it to "_" and the next word
                        const prev = mergedTokens.pop()!;
                        mergedTokens.push({
                            text: prev.text + '_' + tokens[i + 1].text,
                            category: prev.category
                        });
                        i++; // skip the next one, since we just merged it
                    } else {
                        mergedTokens.push(cur);
                    }
                }
                tokens = mergedTokens;
                log(`mergedTokens : ${mergedTokens}`);

                // 2) Build flat action list
                type Action =
                    | { kind: 'text'; text: string; category: string }
                    | { kind: 'earcon'; token: string; category: string }
                    | { kind: 'special'; token: string; category: string };

                const actions: Action[] = [];
                let buffer = '';
                let bufferCat: string | null = null;

                function flush() {
                    if (!buffer.trim()) {
                        buffer = '';
                        bufferCat = null;
                        return;
                    }
                    actions.push({ kind: 'text', text: buffer, category: bufferCat! });
                    buffer = '';
                    bufferCat = null;
                }

                /**
                 * Split any text token into the same sequence of text/earcon/special
                 * actions you already use for identifiers, numbers, punctuation, etc.
                 */
                function splitToken(text: string, category: string) {
                    const twoLenExceptions = new Set(['no', 'is', 'if', 'on', 'in', 'to', 'by']);
                    const threeLenExceptions = new Set(['fmt', 'rgb', 'str']);
                    // 1) 2-letter words: split unless exception
                    if (/^[A-Za-z]{2}$/.test(text)) {
                        if (!twoLenExceptions.has(text.toLowerCase())) {
                            for (const ch of text) actions.push({ kind: 'text', text: ch, category });
                        } else {
                            actions.push({ kind: 'text', text, category });
                        }
                        return;
                    }
                    // 2) 3-letter words: if in dictionary && not exception, whole; else split
                    if (/^[A-Za-z]{3}$/.test(text)) {
                        const lower = text.toLowerCase();
                        if (isDictionaryWord(text) && !threeLenExceptions.has(lower)) {
                            actions.push({ kind: 'text', text, category });
                        } else {
                            for (const ch of text) actions.push({ kind: 'text', text: ch, category });
                        }
                        return;
                    }
                    // ── X) If this token contains any special characters, split and group runs ──
                    if (/[\\{},]/.test(text)) {
                        let buf = '';
                        for (const ch of text) {
                            if (/[\\{},]/.test(ch)) {
                                // flush buffered text first
                                if (buf) {
                                    actions.push({ kind: 'text', text: buf, category });
                                    buf = '';
                                }
                                // emit special or earcon
                                if (isEarcon(ch, audioMap)) {
                                    actions.push({ kind: 'earcon', token: ch, category });
                                } else if (isSpecial(ch)) {
                                    actions.push({ kind: 'special', token: ch, category });
                                } else {
                                    actions.push({ kind: 'text', text: ch, category });
                                }
                            } else {
                                buf += ch;
                            }
                        }
                        // flush any remaining buffered text
                        if (buf) {
                            actions.push({ kind: 'text', text: buf, category });
                        }
                        return;
                    }
                    // C) Dictionary words
                    if (/^[A-Za-z]+$/.test(text) && isDictionaryWord(text)) {
                        actions.push({ kind: 'text', text, category });
                        return;
                    }

                    // UNDERSCORE splitting
                    if (text.includes('_')) {
                        for (const part of text.split(/(_)/)) {
                            if (!part) continue;
                            if (part === '_') {
                                actions.push({ kind: 'special', token: '_', category });
                            } else if (part.length <= 2) {
                                for (const ch of part) actions.push({ kind: 'text', text: ch, category });
                            } else {
                                actions.push({ kind: 'text', text: part, category });
                            }
                        }
                        return;
                    }

                    // Acronym / digit / other-run splitting
                    if (/[A-Za-z]/.test(text) && /\d|[^A-Za-z0-9]/.test(text)) {
                        for (const run of text.match(/[A-Za-z]+|\d+|[^A-Za-z0-9]+/g)!) {
                            if (/^[A-Za-z]+$/.test(run)) {
                                const lower = run.toLowerCase();
                                if (run.length === 2) {
                                    // Two-letter run: split unless in exceptions
                                    if (!twoLenExceptions.has(lower)) {
                                        for (const ch of run) {
                                            actions.push({ kind: 'text', text: ch, category });
                                        }
                                    } else {
                                        actions.push({ kind: 'text', text: run, category });
                                    }
                                } else if (run.length === 3) {
                                    // Three-letter run: keep whole unless in exceptions (in which case split)
                                    if (threeLenExceptions.has(lower)) {
                                        for (const ch of run) {
                                            actions.push({ kind: 'text', text: ch, category });
                                        }
                                    } else {
                                        actions.push({ kind: 'text', text: run, category });
                                    }
                                } else {
                                    actions.push({ kind: 'text', text: run, category });
                                }
                            } else if (/^\d+$/.test(run)) {
                                for (const ch of run) actions.push({ kind: 'special', token: ch, category });
                            } else {
                                for (const ch of run) {
                                    if (isEarcon(ch, audioMap)) actions.push({ kind: 'earcon', token: ch, category });
                                    else if (isSpecial(ch)) actions.push({ kind: 'special', token: ch, category });
                                    else actions.push({ kind: 'text', text: ch, category });
                                }
                            }
                        }
                        return;
                    }

                    // CamelCase splitting
                    if (isCamelCase(text)) {
                        for (const seg of splitCamel(text)) {
                            if (/^[A-Z]/.test(seg)) {
                                actions.push({ kind: 'text', text: seg, category });
                            } else {
                                for (const ch of seg) actions.push({ kind: 'text', text: ch, category });
                            }
                        }
                        return;
                    }

                    // Pure punctuation/digits/runs
                    if (!/^[A-Za-z]+$/.test(text) && [...text].every(ch => isEarcon(ch, audioMap) || isSpecial(ch))) {
                        for (const ch of text) {
                            if (isEarcon(ch, audioMap)) actions.push({ kind: 'earcon', token: ch, category });
                            else if (isSpecial(ch)) actions.push({ kind: 'special', token: ch, category });
                            else actions.push({ kind: 'text', text: ch, category });
                        }
                        return;
                    }

                    // Fallback: everything else as one text chunk
                    actions.push({ kind: 'text', text, category });
                }

                console.log('⏺ raw LSP tokens:', tokens);

                for (let i = 0; i < tokens.length; i++) {
                    const { text, category } = tokens[i];
                    // 1) Two-letter tokens: split into letters unless whitelisted
                    if (/^[A-Za-z]{2}$/.test(text) && !['keyword', 'comment', 'string'].includes(category)) {
                        console.log(`↳ two‐letter split for “${text}” at index`);
                        flush();
                        const twoLenExceptions = new Set(['no', 'is', 'if', 'on', 'in']);
                        if (!twoLenExceptions.has(text.toLowerCase())) {
                            for (const ch of text) actions.push({ kind: 'text', text: ch, category });
                        } else {
                            actions.push({ kind: 'text', text, category });
                        }
                        continue;
                    }
                    // 2) Three-letter tokens: if in dictionary and not exception, read whole; else split
                    if (/^[A-Za-z]{3}$/.test(text) && !['keyword', 'comment', 'string'].includes(category)) {
                        flush();
                        const threeLenExceptions = new Set(['fmt']);
                        const lower = text.toLowerCase();
                        if (isDictionaryWord(text) && !threeLenExceptions.has(lower)) {
                            actions.push({ kind: 'text', text, category });
                        } else {
                            for (const ch of text) actions.push({ kind: 'text', text: ch, category });
                        }
                        continue;
                    }
                    if (text.includes('_')) {
                        flush();
                        console.log('▶▶ underscore-split token:', JSON.stringify(text));
                        const parts = text.split(/(_)/);
                        console.log('   parts:', parts, 'lengths:', parts.map(p => p.length));
                        for (const part of parts) {
                            if (!part) continue;
                            console.log('     ↳ part:', JSON.stringify(part), 'len=', part.length);
                            if (part === '_') {
                                actions.push({ kind: 'special', token: '_', category });
                            } else if (part.length <= 2) {
                                for (const ch of part) {
                                    actions.push({ kind: 'text', text: ch, category });
                                }
                            } else {
                                actions.push({ kind: 'text', text: part, category });
                            }
                        }
                        continue;
                    }


                    // ── A) Comments: read full sentence but split out special characters, and force en_41 without caching ─────────────────
                    if (category === 'comment') {
                        // Accumulate full comment text
                        let full = text;
                        while (i + 1 < tokens.length && tokens[i + 1].category === 'comment') {
                            i++;
                            full += tokens[i].text;
                        }
                        // Split into runs: sequences of non-special vs special characters
                        const runs = full.match(/[^!@#\$%\^&\*\(\)\[\]\{\},\.\?]+|[!@#\$%\^&\*\(\)\[\]\{\},\.\?]/g) || [full];
                        for (const run of runs) {
                            if (/^[!@#\$%\^&\*\(\)\[\]\{\},\.\?]$/.test(run)) {
                                actions.push({ kind: 'special', token: run, category });
                            } else {
                                actions.push({ kind: 'text', text: run, category });
                            }
                        }
                        continue;
                    }
                    // ── B) STRING LITERALS: detect prefixes & delimiters robustly ────────────
                    const stringMatch = /^(?:[rbufRBUF]*)(['"])([\s\S]*?)\1$/.exec(text);
                    if (stringMatch || category === 'string') {
                        // flush any buffered text first
                        flush();
                        const delim = stringMatch ? stringMatch[1] : text[0];
                        const content = stringMatch ? stringMatch[2] : text.slice(1, -1);
                        // opening quote earcon
                        actions.push({ kind: 'earcon', token: delim, category });
                        // split inner content
                        if (content) splitToken(content, category);
                        // closing quote earcon
                        actions.push({ kind: 'earcon', token: delim, category });
                        continue;
                    }

                    // ── 2) Bypass keywords (don’t split “for”, “if”, “in”, etc.) ───────────
                    if (category === 'keyword') {
                        if (bufferCat === category) {
                            buffer += text;
                        } else {
                            flush();
                            buffer = text;
                            bufferCat = category;
                        }
                        continue;
                    }



                    // ── C) Dictionary words: read whole if in our word list ───────
                    if (/^[A-Za-z]+$/.test(text) && isDictionaryWord(text)) {
                        flush();
                        actions.push({ kind: 'text', text, category });
                        continue;
                    }
                    // ── C) UNDERSCORE SPLITTING (now first!) ────────────────────────────────
                    if (text.includes('_')) {
                        flush();
                        console.log('▶▶ underscore-split token:', JSON.stringify(text));
                        for (const part of text.split(/(_)/)) {
                            if (!part) continue;
                            if (part === '_') {
                                actions.push({ kind: 'special', token: '_', category });
                            } else {
                                if (part.length <= 2) {
                                    // -- log each letter as we push it --
                                    for (const ch of part) {
                                        console.log('    ↳ splitting letter:', ch);
                                        actions.push({ kind: 'text', text: ch, category });
                                    }
                                } else {
                                    actions.push({ kind: 'text', text: part, category });
                                }
                            }
                        }
                        continue;
                    }

                    // ── D) ACRONYM / DIGIT SPLITTING ─────────────────────────────────────────
                    if (category === 'variable' && /[A-Za-z]/.test(text) && /\d|[^A-Za-z0-9]/.test(text)) {
                        flush();
                        const runs = text.match(/[A-Za-z]+|\d+|[^A-Za-z0-9]+/g)!;
                        for (const run of runs) {
                            if (/^[A-Za-z]+$/.test(run)) {
                                // only split short runs ≤2; longer stay chunk
                                if (run.length <= 2) {
                                    for (const ch of run) actions.push({ kind: 'text', text: ch, category });
                                } else {
                                    actions.push({ kind: 'text', text: run, category });
                                }
                            } else if (/^\d+$/.test(run)) {
                                for (const ch of run) actions.push({ kind: 'special', token: ch, category });
                            } else {
                                for (const ch of run) {
                                    if (isEarcon(ch, audioMap)) actions.push({ kind: 'earcon', token: ch, category });
                                    else if (isSpecial(ch)) actions.push({ kind: 'special', token: ch, category });
                                    else actions.push({ kind: 'text', text: ch, category });
                                }
                            }
                        }
                        continue;
                    }

                    // ── D) CamelCase splitting ──────────────────────────────────────
                    if (isCamelCase(text)) {
                        flush();
                        for (const segment of splitCamel(text)) {
                            if (/^[A-Z]/.test(segment)) {
                                actions.push({ kind: 'text', text: segment, category });
                            } else {
                                for (const ch of segment) {
                                    actions.push({ kind: 'text', text: ch, category });
                                }
                            }
                        }
                        continue;
                    }

                    // ── E) Punctuation/special splitting ───────────────────────────
                    if (text.length > 1 && [...text].every(ch => isEarcon(ch, audioMap) || isSpecial(ch))) {
                        flush();
                        for (const ch of text) {
                            if (isEarcon(ch, audioMap)) {
                                actions.push({ kind: 'earcon', token: ch, category });
                            } else if (isSpecial(ch)) {
                                actions.push({ kind: 'special', token: ch, category });
                            } else {
                                actions.push({ kind: 'text', text: ch, category });
                            }
                        }
                        continue;
                    }

                    // ── F) Single-char earcon? ──────────────────────────────────────────────────
                    if (isEarcon(text, audioMap)) {
                        flush();
                        actions.push({ kind: 'earcon', token: text, category });

                        // ── G) Single char Special? ───────────────────────────────────────────
                    } else if (isSpecial(text)) {
                        flush();
                        actions.push({ kind: 'special', token: text, category });

                        // ── H) Otherwise, accumulate same category text ────────────────────
                    } else {
                        if (bufferCat === category) {
                            buffer += text;
                        } else {
                            flush();
                            buffer = text;
                            bufferCat = category;
                        }
                    }
                }
                flush();  // push any trailing text

                // 1. Merge adjacent text actions to reduce speakToken calls
                const mergedActions: Action[] = [];
                let accText = '';
                let accCat: string | null = null;

                for (const act of actions) {
                    if (act.kind === 'text') {
                        // detect a single‐letter split chunk:
                        const isSplitLetter = act.text.length === 1 && act.category === 'variable';
                        // only merge if same category AND NOT two split‐letters in a row
                        if (
                            accCat === act.category
                            && !(isSplitLetter && accText.length === 1)
                        ) {
                            accText += act.text;
                        } else {
                            if (accText) mergedActions.push({ kind: 'text', text: accText, category: accCat! });
                            accText = act.text;
                            accCat = act.category;
                        }
                    } else {
                        // flush any pending text
                        if (accText) {
                            mergedActions.push({ kind: 'text', text: accText, category: accCat! });
                            accText = '';
                            accCat = null;
                        }
                        // push the non-text action
                        mergedActions.push(act);
                    }
                }
                // final flush
                if (accText) mergedActions.push({ kind: 'text', text: accText, category: accCat! });

                // Strip any leading characters in a text chunk that were just played as an earcon
                for (let i = 1; i < mergedActions.length; i++) {
                    const prev = mergedActions[i - 1];
                    const curr = mergedActions[i];
                    if (prev.kind === 'earcon' && curr.kind === 'text') {
                        let txt = curr.text;
                        // Remove all repeating leading tokens
                        while (txt.startsWith(prev.token)) {
                            txt = txt.slice(prev.token.length);
                        }
                        curr.text = txt;
                    }
                }

                // Remove consecutive duplicate special tokens (e.g., repeated digits)
                let deduped: Action[] = [];
                for (const act of mergedActions) {
                    const prev = deduped[deduped.length - 1];
                    if (
                        prev
                        && act.kind === 'special'
                        && prev.kind === 'special'
                        && act.token === prev.token
                    ) {
                        continue; // skip duplicate
                    }
                    deduped.push(act);
                }
                mergedActions.splice(0, mergedActions.length, ...deduped);
                console.log('🔍 mergedActions:', mergedActions);

                // 3) Pipeline TTS: kick off all generation immediately
                const audioFiles = mergedActions.map(act => {
                    // For comment actions, always generate fresh TTS with en_41 voice, bypassing cache
                    if (act.category === 'comment') {
                        switch (act.kind) {
                            case 'special':
                                return genTokenAudio(act.token, 'comment', { speaker: 'en_41' });
                            case 'text':
                                return genTokenAudio(act.text, 'comment', { speaker: 'en_41' });
                            default:
                                // This should never happen for comments
                                throw new Error(`Unexpected comment action kind: ${act.kind}`);
                        }
                    }
                    if (act.kind === 'earcon') {
                        return Promise.resolve(audioMap[act.token]);
                    } else if (act.kind === 'special') {
                        if (act.category === 'variable') {
                            // Use preloaded on-disk audio for variable characters
                            return Promise.resolve(audioMap[act.token]);
                        } else {
                            // Speak other special characters via TTS using word mapping
                            // const word = specialCharMap[act.token];
                            // return genTokenAudio(word, 'text');
                            const word = specialCharMap[act.token];
                            return genTokenAudio(word, act.category);
                        }
                    } else if (act.kind === 'text' && act.text.length === 1) {
                        if (act.category === 'variable' && audioMap[act.text]) {
                            // use preloaded audio for variable letters/numbers
                            return Promise.resolve(audioMap[act.text]);
                        } else {
                            // use TTS (inference or cache) for others
                            return genTokenAudio(act.text, act.category);
                        }
                    } else {
                        const ttsCat = act.category === 'string' ? 'text' : act.category;
                        return genTokenAudio(act.text, ttsCat);
                    }
                });

                // 4) Play in order, after ensuring all audio is generated
                const files = await Promise.all(audioFiles);
                // Instrument playback loop with timing logs
                log('[diagnostic] Starting playback of tokens');
                for (let idx = 0; idx < mergedActions.length; idx++) {
                    const act = mergedActions[idx];
                    const file = files[idx];
                    const start = process.hrtime.bigint();
                    log(`[diagnostic] About to play token ${idx} kind = ${act.kind} `);
                    if (act.kind === 'text') {
                        // Regular text chunks via PCM streamer
                        await playSequence([file], { rate: config.playSpeed });
                    } else if (act.kind === 'earcon') {
                        // Punctuation/symbol earcons with a brief pause
                        await playWave(file, { isEarcon: true });
                        const pauseMs = 200 / config.playSpeed;
                        await delay(pauseMs);
                    } else if (act.kind === 'special') {
                        // Spoken words for symbols/digits
                        await playSequence([file], { rate: config.playSpeed });
                    }
                    const end = process.hrtime.bigint();
                    const ms = Number(end - start) / 1e6;
                    log(`[diagnostic] Played token ${idx} in ${ms.toFixed(2)} ms`);
                }
                log('[diagnostic] Completed playback of all tokens');

            } catch (err: any) {
                // persist into the LipCoder Output channel:
                log(`⏺ readLineTokens error: ${err.stack || err} `);
                lipcoderLog.show(/* preserveFocus */ false);

                // still let the user know:
                vscode.window.showErrorMessage(`readLineTokens failed: ${err.message} `);
            }
        })
    );
}