import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { stopReadLineTokens } from './stop_reading';
import { stopPlayback, speakToken } from '../audio';

export function registerNavExplorer(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.explorerUp', async () => {
            stopReadLineTokens();
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
                await speakToken(name, 'folder');
            } else {
                await speakToken(name);
            }
        }),
        vscode.commands.registerCommand('lipcoder.explorerDown', async () => {
            stopReadLineTokens();
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
                await speakToken(name, 'folder');
            } else {
                await speakToken(name);
            }
        })
    );
}
