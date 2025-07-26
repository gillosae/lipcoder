import { ExtensionContext } from 'vscode';
import * as vscode from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import { log } from '../utils';
import { stopPlayback, speakTokenList } from '../audio';

export function registerReadFunctionTokens(
    context: ExtensionContext,
    client: LanguageClient,
) {
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.readFunctionTokens', async (editorArg?: vscode.TextEditor) => {
            try {
                const editor = editorArg ?? vscode.window.activeTextEditor;
                if (!editor || editor.document.uri.scheme !== 'file') {
                    vscode.window.showWarningMessage('No active file editor!');
                    return;
                }
                // Stop any ongoing audio
                stopPlayback();

                const uri = editor.document.uri.toString();
                const position = editor.selection.active;
                log(`[readFunctionTokens] invoked for ${uri} at line ${position.line}, char ${position.character}`);

                // Request tokens for the current function from the LSP
                let tokData: { text: string; category: string }[];
                try {
                    tokData = await client.sendRequest('lipcoder/readFunctionTokens', { uri, position });
                } catch (err) {
                    console.error('LSP request failed:', err);
                    return;
                }
                log(`[readFunctionTokens] received ${tokData.length} tokens`);

                // Speak each token in sequence
                for (const { text, category } of tokData) {
                    if (text.trim() === '') continue;
                    await speakTokenList([{ tokens: [text], category }]);
                }
            } catch (err: any) {
                console.error('readFunctionTokens error:', err);
            }
        })
    );
}