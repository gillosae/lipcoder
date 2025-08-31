

import * as vscode from 'vscode';
import type { ExtensionContext } from 'vscode';
import { playWave, speakTokenList, speakGPT, TokenChunk } from '../audio';
import { config } from '../config';
import { lineAbortController } from './stop_reading';
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
            // ASCII visualization
            function printTree(nodes: FileNode[], indent = '') {
                nodes.forEach((node, idx) => {
                    const isLast = idx === nodes.length - 1;
                    const pointer = isLast ? '└─ ' : '├─ ';
                    // Tree visualization removed for cleaner output
                    if (node.children) {
                        const childIndent = indent + (isLast ? '   ' : '│  ');
                        printTree(node.children, childIndent);
                    }
                });
            }
            printTree(tree);

            // 2) File tree built but automatic reading disabled
            await speakGPT('File tree built. Use explorer navigation to browse files.', lineAbortController.signal);
            
            // Removed automatic file tree reading - users can navigate manually
            fileTreeAbortController = null; // Done
            vscode.window.showInformationMessage('File tree built - use explorer navigation to browse');
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