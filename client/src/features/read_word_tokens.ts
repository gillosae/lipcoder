import * as vscode from 'vscode';
import { stopPlayback, speakTokenList } from '../audio';
import { log } from '../utils';
import { splitWordChunks } from './word_logic';

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
                const tokens = /^\d+$/.test(word)
                    ? [word]
                    : splitWordChunks(word);
                await speakTokenList([{ tokens, category: 'literal' }]);
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