import type { ExtensionContext } from 'vscode';
import * as vscode from 'vscode';
import { log } from '../utils';
import { specialCharMap } from '../mapping';
import { LanguageClient } from 'vscode-languageclient/node';
import { splitWordChunks } from './word_logic';
import { speakTokenList } from '../audio';
import { stopReading, lineAbortController } from './stop_reading';
import { isEditorActive } from '../ide/active';


export function registerReadLineTokens(context: ExtensionContext, client: LanguageClient) {
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.readLineTokens', async (editorArg?: vscode.TextEditor) => {
            const editor = isEditorActive(editorArg);
            if (!editor) return;

            const docLang = editor.document.languageId === 'python' ? 'python' : 'typescript';

            // Global stop: abort any ongoing audio and controller
            stopReading();

            const uri = editor.document.uri.toString();
            const line = editor.selection.active.line;

            // Fetch tokens and categories from LSP
            let tokenData: { text: string; category: string }[];

            try {
                tokenData = await client.sendRequest('lipcoder/readLineTokens', { uri, line });
            } catch (err) {
                console.error('LSP request failed:', err);
                return;
            }
            log(`[readLineTokens] received ${tokenData.length} tokens: ${JSON.stringify(tokenData)}`);

            // Drop first chunk if it's only whitespace
            if (tokenData.length > 0 && tokenData[0].text.trim() === '') {
                tokenData = tokenData.slice(1);
            }

            // Prepare token chunks and speak them
            const validChunks = tokenData.map(({ text, category }) => ({
                tokens: splitWordChunks(text),
                category
            }));
            // log(`[readLineTokens] split chunks: ${JSON.stringify(validChunks)}`);

            // Log the upcoming audio tokens in human‐readable form
            const flatTokens = validChunks.flatMap(({ tokens }) => tokens);
            const spokenSeq = flatTokens
                .map(tok => specialCharMap[tok] ? `(${specialCharMap[tok]})` : tok)
                .join(' ');
            log(`[readLineTokens] speak sequence: ${spokenSeq}`);

            try {
                await speakTokenList(validChunks, lineAbortController.signal);
            } catch (err: any) {
                console.error('[readLineTokens] error:', err);
            }
        })
    );
}