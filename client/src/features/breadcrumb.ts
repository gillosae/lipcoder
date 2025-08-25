import { stopReading } from './stop_reading';
import * as vscode from 'vscode';
import * as path from 'path';
import type { ExtensionContext } from 'vscode';
import type { DocumentSymbol } from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import { speakTokenList, TokenChunk } from '../audio';

export function registerBreadcrumb(
    context: ExtensionContext,
    client: LanguageClient
) {
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.breadcrumb', async (editorArg?: vscode.TextEditor) => {
            const { isEditorActive } = require('../ide/active');
            const editor = editorArg || isEditorActive();
            if (!editor) {
                vscode.window.setStatusBarMessage('Open a file first!', 3000);
                return;
            }
            const originalSelection = editor.selection;
            const pos = editor.selection.active;
            const uri = editor.document.uri;
            const relativePath = vscode.workspace.asRelativePath(uri);
            // Fetch all document symbols
            const tree = (await vscode.commands.executeCommand<DocumentSymbol[]>(
                'vscode.executeDocumentSymbolProvider',
                uri
            )) || [];
            // Find path of symbols containing the cursor
            function findPath(nodes: DocumentSymbol[]): { label: string; line: number }[] {
                for (const node of nodes) {
                    if (
                        (pos.line > node.range.start.line ||
                            (pos.line === node.range.start.line && pos.character >= node.range.start.character)) &&
                        (pos.line < node.range.end.line ||
                            (pos.line === node.range.end.line && pos.character <= node.range.end.character))
                    ) {
                        const label = `${vscode.SymbolKind[node.kind].toLowerCase()}: ${node.name}`;
                        const childPath = findPath(node.children || []);
                        return [{ label, line: node.range.start.line }, ...childPath];
                    }
                }
                return [];
            }
            const pathItems = findPath(tree);
            // Speak current location
            const message = pathItems.length
                ? `You are in ${relativePath} ${pathItems[0].label}`
                : `You are in ${relativePath}`;
            stopReading();
            await speakTokenList([{ tokens: [message], category: undefined }]);
            if (pathItems.length === 0) {
                vscode.window.showInformationMessage(message);
                return;
            }
            // QuickPick for navigation
            let accepted = false;
            let hideHandled = false;
            const quickPick = vscode.window.createQuickPick<{ label: string; line: number }>();
            quickPick.items = pathItems.map(item => ({
                label: item.label,
                line: item.line
            }));
            quickPick.placeholder = 'Navigate breadcrumb…';
            quickPick.onDidChangeActive(active => {
                stopReading();
                const sel = active[0];
                if (sel) {
                    const { line, label } = sel;
                    const p = new vscode.Position(line, 0);
                    editor.selection = new vscode.Selection(p, p);
                    editor.revealRange(new vscode.Range(p, p));
                    speakTokenList([{ tokens: [label], category: undefined }]);
                }
            });
            quickPick.onDidAccept(() => {
                accepted = true;
                const sel = quickPick.activeItems[0];
                if (sel) {
                    stopReading();
                    speakTokenList([{ tokens: [`moved to ${sel.label} line ${sel.line + 1}`], category: undefined }]);
                }
                quickPick.hide();
            });
            quickPick.onDidHide(() => {
                if (!hideHandled) {
                    hideHandled = true;
                    if (!accepted) {
                        const pos0 = originalSelection.active;
                        editor.selection = originalSelection;
                        editor.revealRange(new vscode.Range(pos0, pos0));
                        stopReading();
                        speakTokenList([{ tokens: [`back to line ${pos0.line + 1}`], category: undefined }]);
                    }
                    quickPick.dispose();
                }
            });
            quickPick.show();
        })
    );
}