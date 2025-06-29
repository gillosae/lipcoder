import { genTokenAudio } from '../audio';
import type { ExtensionContext } from 'vscode';
import * as vscode from 'vscode';
import { speakToken } from '../audio';
import { numberMap } from '../mapping';
import { LanguageClient } from 'vscode-languageclient/node';

// Track last preloaded line to avoid repeated spawns
let lastPreloadedLine: number | undefined;

export function registerReadCurrentLine(context: ExtensionContext) {
    // Cache current line TTS on cursor move
    context.subscriptions.push(
        vscode.window.onDidChangeTextEditorSelection(async e => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;
            const lineNum = editor.selection.active.line + 1;
            // Only preload on actual line change
            if (lineNum === lastPreloadedLine) return;
            lastPreloadedLine = lineNum;
            const numberWord = numberMap[lineNum.toString()] || String(lineNum);
            try {
                await genTokenAudio(numberWord, 'literal');
            } catch {
                /* ignore caching errors */
            }
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.readCurrentLine', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('No active editor!');
                return;
            }

            const lineNum = editor.selection.active.line + 1; // zero-based → human count
            const msg = `Line ${lineNum}`;
            vscode.window.showInformationMessage(msg);
            const tokens = msg.split(/\s+/).filter(t => t.length > 0);
            for (const token of tokens) {
                // If the token is purely digits and exists in our map, use the word form
                const toSpeak = /^\d+$/.test(token) && numberMap[token]
                    ? numberMap[token]
                    : token;
                await speakToken(toSpeak, 'literal');
            }
        })
    );
}