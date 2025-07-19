// in symbol_tree.ts
import * as vscode from 'vscode';
import type { ExtensionContext } from 'vscode';
import type { DocumentSymbol } from 'vscode';
import { playWave, speakToken } from '../audio';
import * as path from 'path';
import { config } from '../config';

export function registerSymbolTree(context: ExtensionContext) {

    // When workspace is loaded, open Explorer, focus its tree, then read the file tree
    // vscode.commands.executeCommand('workbench.view.explorer')
    // 	.then(async () => {
    // 		// Move focus into the file list
    // 		await vscode.commands.executeCommand('workbench.files.action.focusFilesExplorer');
    // 		// Finally read out the tree
    // 		await vscode.commands.executeCommand('lipcoder.fileTree');
    // 	});

    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.symbolTree', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('Open a file first!');
                return;
            }
            const uri = editor.document.uri;
            // 1) Fetch the symbol tree for the current file
            const tree = (await vscode.commands.executeCommand<DocumentSymbol[]>(
                'vscode.executeDocumentSymbolProvider',
                uri
            )) || [];
            console.log('Symbol tree:', tree);
            // Visualize the symbol tree as an ASCII diagram in the console
            function printTree(nodes: DocumentSymbol[], indent = '') {
                nodes.forEach((node, idx) => {
                    const isLast = idx === nodes.length - 1;
                    const pointer = isLast ? '└─ ' : '├─ ';
                    console.log(`${indent}${pointer}${vscode.SymbolKind[node.kind]}: ${node.name}`);
                    const childIndent = indent + (isLast ? '   ' : '│  ');
                    if (node.children && node.children.length) {
                        printTree(node.children, childIndent);
                    }
                });
            }
            printTree(tree);
            // 2) Flatten & annotate with depth
            const chunks: { tokens: string[]; depth: number }[] = [];
            function walk(nodes: DocumentSymbol[], depth = 0) {
                for (const node of nodes) {
                    // e.g. ["class", "Foo"] or ["function", "bar"]
                    const kindName = vscode.SymbolKind[node.kind].toLowerCase();
                    chunks.push({ tokens: [kindName, node.name], depth });
                    if (node.children.length) {
                        walk(node.children, depth + 1);
                    }
                }
            }
            walk(tree, 0);

            // Max indent constant
            const MAX_INDENT_UNITS = 5;

            // 4) Sonify symbol tree with indent earcons and TTS
            for (const { tokens, depth } of chunks) {
                // Play indent earcon based on depth
                const idx = depth >= MAX_INDENT_UNITS ? MAX_INDENT_UNITS - 1 : depth;
                const file = path.join(config.audioPath(), 'earcon', `indent_${idx}.wav`);
                await playWave(file, { isEarcon: true, immediate: true });
                // Speak symbol kind and name
                await speakToken(tokens[0]); // e.g., "class" or "function"
                await speakToken(tokens[1], `symbol_${tokens[0]}`); // the identifier name
            }
        })
    );
}