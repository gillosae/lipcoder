import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { stopReading } from './stop_reading';
import { speakTokenList, TokenChunk } from '../audio';

export function registerNavExplorer(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.explorerUp', async () => {
            stopReading();
            await vscode.commands.executeCommand('list.focusUp');
            await vscode.commands.executeCommand('copyFilePath');
            const filePath = await vscode.env.clipboard.readText();
            const name = path.basename(filePath);
            let isDir = false;
            try {
                const stat = fs.statSync(filePath);
                isDir = stat.isDirectory();
            } catch { }
            if (isDir) {
                await speakTokenList([{ tokens: [name], category: 'folder' }]);
            } else {
                await speakTokenList([{ tokens: [name], category: undefined }]);
            }
        }),
        vscode.commands.registerCommand('lipcoder.explorerDown', async () => {
            stopReading();
            await vscode.commands.executeCommand('list.focusDown');
            await vscode.commands.executeCommand('copyFilePath');
            const filePath = await vscode.env.clipboard.readText();
            const name = path.basename(filePath);
            let isDir = false;
            try {
                const stat = fs.statSync(filePath);
                isDir = stat.isDirectory();
            } catch { }
            if (isDir) {
                await speakTokenList([{ tokens: [name], category: 'folder' }]);
            } else {
                await speakTokenList([{ tokens: [name], category: undefined }]);
            }
        })
    );
}
