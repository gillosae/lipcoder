import type { ExtensionContext } from 'vscode';
import * as vscode from 'vscode';
import { log } from '../utils';
import { LanguageClient } from 'vscode-languageclient/node';
import type { SymbolInformation } from 'vscode-languageserver-types';
import { speakTokenList, TokenChunk } from '../audio';

export function registerWhereAmI(context: ExtensionContext, client: LanguageClient) {
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.whereAmI', async () => {
            const { isEditorActive } = require('../ide/active');
            const editor = isEditorActive();
            if (!editor) {
                vscode.window.setStatusBarMessage('No active editor!', 3000);
                return;
            }
            const uri = editor.document.uri.toString();

            try {
                const symbols = await client.sendRequest<SymbolInformation[]>(
                    'textDocument/documentSymbol',
                    { textDocument: { uri } }
                );

                const pos = editor.selection.active;
                const containing = symbols
                    .filter((s) => {
                        const r = s.location.range;
                        return (
                            (pos.line > r.start.line ||
                                (pos.line === r.start.line &&
                                    pos.character >= r.start.character)) &&
                            (pos.line < r.end.line ||
                                (pos.line === r.end.line &&
                                    pos.character <= r.end.character))
                        );
                    })
                    .sort((a, b) => {
                        const lenA =
                            a.location.range.end.line - a.location.range.start.line;
                        const lenB =
                            b.location.range.end.line - b.location.range.start.line;
                        return lenA - lenB;
                    });

                if (containing.length === 0) {
                    vscode.window.showInformationMessage('Outside of any symbol.');
                    await speakTokenList([{ tokens: ['You are outside of any symbol.'], category: undefined }]);
                } else {
                    const symbol = containing[0];
                    const container = symbol.containerName
                        ? `${symbol.containerName} → `
                        : '';
                    const msg = `${container}${symbol.name}`;
                    vscode.window.showInformationMessage(`You are in: ${msg}`);
                    await speakTokenList([{ tokens: [`You are in ${msg}`], category: undefined }]);
                }
            } catch (err) {
                vscode.window.showErrorMessage(`whereAmI failed: ${err}`);
            }
        })
    );
}