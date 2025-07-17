import * as vscode from 'vscode';
import type { ExtensionContext, DocumentSymbol } from 'vscode';
import { playWave, speakToken } from '../audio';
import * as path from 'path';
import { config } from '../config';

export function registerFunctionList(context: ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.functionList', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('Open a file first!');
                return;
            }
            const uri = editor.document.uri;
            // 1) Get the document symbol tree
            const tree = (await vscode.commands.executeCommand<DocumentSymbol[]>(
                'vscode.executeDocumentSymbolProvider',
                uri
            )) || [];
            // 2) Collect all functions/methods with nesting depth
            const funcs: { name: string; depth: number }[] = [];
            function walk(nodes: DocumentSymbol[], depth: number) {
                for (const node of nodes) {
                    if (
                        node.kind === vscode.SymbolKind.Function ||
                        node.kind === vscode.SymbolKind.Method
                    ) {
                        funcs.push({ name: node.name, depth });
                    }
                    if (node.children && node.children.length) {
                        walk(node.children, depth + 1);
                    }
                }
            }
            walk(tree, 0);
            if (funcs.length === 0) {
                vscode.window.showInformationMessage('No functions found in this file.');
                return;
            }
            // 3) Announce and sonify
            await speakToken('functions');
            const MAX_INDENT_UNITS = 5;
            for (const fn of funcs) {
                // play indent earcon
                const idx = fn.depth >= MAX_INDENT_UNITS ? MAX_INDENT_UNITS - 1 : fn.depth;
                const file = path.join(config.audioPath(), 'earcon', `indent_${idx}.wav`);
                await playWave(file, { isEarcon: true, immediate: true });
                // speak function name
                await speakToken(fn.name);
            }
            vscode.window.showInformationMessage(`Spoke ${funcs.length} function(s)`);
        })
    );
}