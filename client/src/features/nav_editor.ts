import * as vscode from 'vscode';
import { log } from '../utils';
import { isFileTreeReading } from './file_tree';
import { stopReadLineTokens } from './stop_read_line_tokens';
import { stopPlayback, speakToken } from '../audio';
import { readWordTokens } from './read_word_tokens';
import { readTextTokens } from './read_text_tokens';
import { config } from '../config';
import { updateLineSeverity } from './line_severity';

export function registerNavEditor(context: vscode.ExtensionContext, audioMap: any) {
    const diagCache = updateLineSeverity();

    let currentLineNum = vscode.window.activeTextEditor?.selection.active.line ?? 0;
    let currentCursor = vscode.window.activeTextEditor?.selection.active ?? new vscode.Position(0, 0);
    let readyForCursor = false;
    setTimeout(() => { readyForCursor = true; }, 2000);

    // Indentation tracking (moved from extension)
    const indentLevels: Map<string, number> = new Map();
    const MAX_INDENT_UNITS = 5;
    const editor = vscode.window.activeTextEditor!;
    const tabSize = typeof editor.options.tabSize === 'number' ? editor.options.tabSize : 4;

    // Toggle between token and word reading mode
    let useWordMode = false;
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.toggleReadMode', () => {
            useWordMode = !useWordMode;
            vscode.window.showInformationMessage(
                `LipCoder: ${useWordMode ? 'Word' : 'Token'} reading mode`
            );
        })
    );

    // Track text change for narration
    let skipNextIndent = false; // Flag to skip indent sound once after Enter
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(async (event) => {
            if (!config.typingSpeechEnabled) return;

            const editor = vscode.window.activeTextEditor;
            if (!editor || event.document !== editor.document) return;

            const changes = event.contentChanges;
            if (changes.length === 0) return;

            if (useWordMode) {
                readWordTokens(event, changes);
            } else {
                readTextTokens(
                    event,
                    diagCache,
                    changes,
                    indentLevels,
                    tabSize,
                    skipNextIndent,
                    MAX_INDENT_UNITS,
                    audioMap
                );
            }
        })
    );

    context.subscriptions.push(
        vscode.window.onDidChangeTextEditorSelection((e) => {
            try {
                if (!readyForCursor) return;
                if (e.kind !== vscode.TextEditorSelectionChangeKind.Keyboard) return;

                const doc = e.textEditor.document;
                const scheme = doc.uri.scheme;
                if (scheme === 'output' || scheme !== 'file') return;
                if (e.textEditor.viewColumn === undefined) return;

                const lineNum = e.selections[0].start.line;
                if (currentLineNum === lineNum) return;

                currentLineNum = lineNum;
                log(`[cursor-log] line=${lineNum}`);
                vscode.commands.executeCommand('lipcoder.readLineTokens', e.textEditor)
                    .then(undefined, err => console.error('readLineTokens failed:', err));
            } catch (err: any) {
                console.error('onDidChangeTextEditorSelection handler error:', err);
            }
        }),
        vscode.window.onDidChangeTextEditorSelection((e) => {
            if (
                e.kind === vscode.TextEditorSelectionChangeKind.Keyboard &&
                e.selections.length === 1 &&
                isFileTreeReading()
            ) {
                stopReadLineTokens();
            }
        }),
        vscode.window.onDidChangeTextEditorSelection((e) => {
            if (
                !readyForCursor ||
                e.kind !== vscode.TextEditorSelectionChangeKind.Keyboard ||
                e.selections.length !== 1 ||
                isFileTreeReading()
            ) return;

            const old = currentCursor;
            const sel = e.selections[0].active;
            if (old && sel.line === old.line && Math.abs(sel.character - old.character) === 1) {
                stopReadLineTokens();
                stopPlayback();

                const doc = e.textEditor.document;
                const char = sel.character > old.character
                    ? doc.getText(new vscode.Range(old, sel))
                    : doc.getText(new vscode.Range(sel, old));

                if (char) {
                    speakToken(char);
                }
                currentCursor = sel;
                return;
            }

            if (sel.line === currentLineNum) {
                currentCursor = sel;
                return;
            }
            currentLineNum = sel.line;
            vscode.commands.executeCommand('lipcoder.readLineTokens', e.textEditor);
            currentCursor = sel;
        })


    );


}
