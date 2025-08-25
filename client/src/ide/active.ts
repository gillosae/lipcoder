import * as vscode from 'vscode';

// Track the last active editor to use as fallback
let lastActiveEditor: vscode.TextEditor | null = null;
let editorChangeListener: vscode.Disposable | null = null;

/**
 * Initialize the last editor tracking system
 */
export function initializeLastEditorTracking(context: vscode.ExtensionContext): void {
    // Set initial last editor if one exists
    if (vscode.window.activeTextEditor) {
        lastActiveEditor = vscode.window.activeTextEditor;
    }

    // Listen for editor changes to track the last active editor
    editorChangeListener = vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor && editor.document.uri.scheme === 'file') {
            lastActiveEditor = editor;
        }
    });

    // Register disposal
    context.subscriptions.push(editorChangeListener);
}

/**
 * Get the last active editor (for fallback purposes)
 */
export function getLastActiveEditor(): vscode.TextEditor | null {
    return lastActiveEditor;
}

export function isEditorActive(editorArg?: vscode.TextEditor): vscode.TextEditor | null {
    const editor = editorArg ?? vscode.window.activeTextEditor;
    
    // If we have an active editor, use it
    if (editor && editor.document.uri.scheme === 'file') {
        return editor;
    }
    
    // Fallback to last active editor if available
    if (lastActiveEditor && lastActiveEditor.document.uri.scheme === 'file') {
        // Check if the last editor is still valid (document still open)
        const isStillOpen = vscode.workspace.textDocuments.some(doc => 
            doc === lastActiveEditor!.document
        );
        
        if (isStillOpen) {
            return lastActiveEditor;
        } else {
            // Clear invalid last editor
            lastActiveEditor = null;
        }
    }
    
    // Only show a subtle notification if no fallback is available
    vscode.window.setStatusBarMessage('No active file editor - please open a code file', 3000);
    return null;
}

export function isTerminalActive(terminalArg?: vscode.Terminal): vscode.Terminal | null {
    const terminal = terminalArg ?? vscode.window.activeTerminal;
    if (!terminal) {
        vscode.window.showWarningMessage('No active terminal!');
        return null;
    }
    return terminal;
}
