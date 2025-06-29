import * as vscode from 'vscode';
import { stopPlayback, speakToken, isEarcon } from '../audio';
import { earconTokens } from '../tokens';
import { config } from '../config';
import { log } from '../utils';

const bufferMap = new Map<string, string>();

export async function readWordTokens(
    event: vscode.TextDocumentChangeEvent,
    changes: readonly vscode.TextDocumentContentChangeEvent[],
) {
    const uri = event.document.uri.toString();
    let buf = bufferMap.get(uri) || '';

    for (const change of changes) {
        const text = change.text;
        // if user types a space (or newline), speak accumulated buffer + the space
        if (text === ' ' || text === '\n' || text === '\t') {
            // halt any ongoing audio
            stopPlayback();

            const word = buf.trim();
            if (word) {
                log(`[readWordTokens] speaking word="${word}"`);
                // Find the longest earcon token that matches the end of the word
                let matched: string | undefined;
                for (const token of earconTokens.sort((a, b) => b.length - a.length)) {
                    if (word.endsWith(token)) {
                        matched = token;
                        break;
                    }
                }
                if (matched) {
                    const main = word.slice(0, -matched.length);
                    if (main) {
                        await speakToken(main, 'literal', { speaker: 'en_3' });
                    }
                    await speakToken(matched);
                } else {
                    await speakToken(word, 'literal', { speaker: 'en_3' });
                }
            }
            // optionally speak the space itself as an earcon or omit
            bufferMap.set(uri, '');
        } else {
            // accumulate characters that are part of the current word
            buf += text;
            bufferMap.set(uri, buf);
        }
    }
}