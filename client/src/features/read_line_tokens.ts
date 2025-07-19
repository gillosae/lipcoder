import * as fs from 'fs';
import type { ExtensionContext } from 'vscode';
import * as vscode from 'vscode';
import { log } from '../utils';
import { specialCharMap } from '../mapping';
import { LanguageClient } from 'vscode-languageclient/node';
import { playEarcon, stopPlayback } from '../audio';
import { splitWordChunks } from './word_logic';
import { speakTokenList } from '../audio';

// Controller to cancel ongoing line-read audio
export let lineAbortController = new AbortController();

export function stopReadLineTokens(): void {
    // Abort any ongoing speech
    lineAbortController.abort();
    // Reset for next invocation
    lineAbortController = new AbortController();
}


export function registerReadLineTokens(context: ExtensionContext, client: LanguageClient, currentAbortController: AbortController | null, audioMap: Record<string, string>) {
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.readLineTokens', async (editorArg?: vscode.TextEditor) => {
            try {
                const editor = editorArg ?? vscode.window.activeTextEditor;
                if (!editor || editor.document.uri.scheme !== 'file') {
                    vscode.window.showWarningMessage('No active file editor!');
                    return;
                }

                // Cancel any prior line-read in progress
                lineAbortController.abort();
                lineAbortController = new AbortController();

                stopPlayback(); // Stop any ongoing audio

                const uri = editor.document.uri.toString();
                const line = editor.selection.active.line;
                log(`[readLineTokens] invoked for ${uri} at line ${line}`);

                // Fetch tokens and categories from LSP
                let tokData: { text: string; category: string }[];
                try {
                    tokData = await client.sendRequest('lipcoder/readLineTokens', { uri, line });
                } catch (err) {
                    console.error('LSP request failed:', err);
                    return;
                }
                log(`[readLineTokens] received ${tokData.length} tokens: ${JSON.stringify(tokData)}`);

                // Determine language for keyword mapping
                const docLang = editor.document.languageId === 'python' ? 'python' : 'typescript';
                log(`[readLineTokens] document language: ${docLang}`);

                // Prepare token chunks and speak them
                const validChunks = tokData
                    .filter(({ text }) => text.trim() !== '')
                    .map(({ text, category }) => ({
                        tokens: splitWordChunks(text),
                        category
                    }));
                console.log(`[readLineTokens] split chunks: ${JSON.stringify(validChunks)}`);
                // Log the upcoming audio tokens in human‐readable form
                const flatTokens = validChunks.flatMap(({ tokens }) => tokens);
                const spokenSeq = flatTokens
                    .map(tok => specialCharMap[tok] ? `(${specialCharMap[tok]})` : tok)
                    .join(' ');
                console.log(`[readLineTokens] speak sequence: ${spokenSeq}`);
                await speakTokenList(validChunks, lineAbortController.signal);
            } catch (err: any) {
                console.error('readLineTokens error:', err);
            }
        })
    );
}