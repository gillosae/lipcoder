import * as vscode from 'vscode';

export function isEditorActive(editorArg?: vscode.TextEditor): vscode.TextEditor | null {
    const editor = editorArg ?? vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') {
        vscode.window.showWarningMessage('No active file editor!');
        return null;
    }
    return editor;
}

export function isTerminalActive(terminalArg?: vscode.Terminal): vscode.Terminal | null {
    const terminal = terminalArg ?? vscode.window.activeTerminal;
    if (!terminal) {
        vscode.window.showWarningMessage('No active terminal!');
        return null;
    }
    return terminal;
}
