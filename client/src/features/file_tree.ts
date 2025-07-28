

import * as vscode from 'vscode';
import type { ExtensionContext } from 'vscode';
import { playWave, speakTokenList, TokenChunk } from '../audio';
import { config } from '../config';
import * as path from 'path';

// Whether to include hidden files and directories (names starting with '.')
// Toggle this to 'true' to read hidden files
let includeHiddenFiles = false;

// Abort controller for file tree reading
let fileTreeAbortController: AbortController | null = null;

interface FileNode {
    name: string;
    uri: vscode.Uri;
    isDirectory: boolean;
    children?: FileNode[];
}

export function registerFileTree(context: ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.fileTree', async () => {
            // Cancel any previous run
            fileTreeAbortController?.abort();

            // Create a new controller for *this* run
            const controller = new AbortController();
            fileTreeAbortController = controller;

            const folders = vscode.workspace.workspaceFolders;
            if (!folders || folders.length === 0) {
                vscode.window.showWarningMessage('No workspace folder open!');
                return;
            }
            const rootUri = folders[0].uri;
            // 1) Read directory recursively
            async function readDir(uri: vscode.Uri): Promise<FileNode[]> {
                const items = await vscode.workspace.fs.readDirectory(uri);
                // Conditionally include hidden items
                const visibleItems = includeHiddenFiles
                    ? items
                    : items.filter(([name]) => !name.startsWith('.'));
                const nodes: FileNode[] = [];
                for (const [name, type] of visibleItems) {
                    const childUri = vscode.Uri.joinPath(uri, name);
                    if (type === vscode.FileType.Directory) {
                        const children = await readDir(childUri);
                        nodes.push({ name, uri: childUri, isDirectory: true, children });
                    } else if (type === vscode.FileType.File) {
                        nodes.push({ name, uri: childUri, isDirectory: false });
                    }
                }
                return nodes;
            }
            const tree = await readDir(rootUri);
            console.log('File tree:', tree);
            // ASCII visualization
            function printTree(nodes: FileNode[], indent = '') {
                nodes.forEach((node, idx) => {
                    const isLast = idx === nodes.length - 1;
                    const pointer = isLast ? '└─ ' : '├─ ';
                    console.log(`${indent}${pointer}${node.name}${node.isDirectory ? '/' : ''}`);
                    if (node.children) {
                        const childIndent = indent + (isLast ? '   ' : '│  ');
                        printTree(node.children, childIndent);
                    }
                });
            }
            printTree(tree);

            // 2) Speak file tree
            await speakTokenList([{ tokens: ['file tree'], category: undefined }]);
            const MAX_INDENT_UNITS = 5;
            async function walkSpeak(nodes: FileNode[], depth = 0) {
                for (const node of nodes) {
                    if (controller.signal.aborted) {
                        return;  // bail out immediately
                    }
                    const idx = depth >= MAX_INDENT_UNITS ? MAX_INDENT_UNITS - 1 : depth;
                    const file = path.join(config.audioPath(), 'earcon', `indent_${idx}.pcm`);
                    await playWave(file, { isEarcon: true, immediate: true });
                    
                    // Speak the file/folder name using speakTokenList
                    if (node.isDirectory) {
                        await speakTokenList([{ tokens: [node.name], category: 'folder' }], controller.signal);
                        if (node.children) {
                            await walkSpeak(node.children, depth + 1);
                        }
                    } else {
                        await speakTokenList([{ tokens: [node.name], category: undefined }], controller.signal);
                    }
                }
            }

            await walkSpeak(tree);
            fileTreeAbortController = null; // Done speaking
            vscode.window.showInformationMessage('Spoken file tree');
        })
    );
}

export function stopFileTreeReading() {
    fileTreeAbortController?.abort();
    fileTreeAbortController = null;
}

/**
 * Returns true if a file-tree read is currently in progress.
 */
export function isFileTreeReading(): boolean {
    return fileTreeAbortController !== null;
}