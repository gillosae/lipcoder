import * as vscode from 'vscode';
import { log } from '../utils';

/**
 * Check if the current editor/document is a debug console or other panel that should be suppressed
 * from automatic reading by lipcoder
 */
export function shouldSuppressReading(editor?: vscode.TextEditor): boolean {
    if (!editor) {
        return false;
    }

    const doc = editor.document;
    const scheme = doc.uri.scheme;
    const path = doc.uri.path;
    const fsPath = doc.uri.fsPath;

    // Debug console detection
    // Debug console typically uses schemes like 'debug', 'repl', or has specific paths
    if (scheme === 'debug' || 
        scheme === 'repl' || 
        scheme === 'debug-console' ||
        path.includes('debug-console') ||
        path.includes('repl') ||
        fsPath.includes('debug-console') ||
        fsPath.includes('Debug Console')) {
        log(`[DebugConsoleDetection] Suppressing reading for debug console: scheme=${scheme}, path=${path}`);
        return true;
    }

    // Output panel detection (already handled but making it explicit)
    if (scheme === 'output') {
        log(`[DebugConsoleDetection] Suppressing reading for output panel: scheme=${scheme}, path=${path}`);
        return true;
    }

    // Additional panel detection for common VS Code panels
    if (scheme === 'vscode' || 
        scheme === 'untitled' ||
        scheme === 'git' ||
        scheme === 'search-editor' ||
        path.includes('search-editor') ||
        path.includes('problems') ||
        path.includes('terminal')) {
        log(`[DebugConsoleDetection] Suppressing reading for VS Code panel: scheme=${scheme}, path=${path}`);
        return true;
    }

    // Check if the document language ID indicates a debug console or output
    const languageId = doc.languageId;
    if (languageId === 'log' || 
        languageId === 'output' || 
        languageId === 'debug-console' ||
        languageId === 'repl') {
        log(`[DebugConsoleDetection] Suppressing reading for debug/output language: languageId=${languageId}`);
        return true;
    }

    // Check document file name patterns
    const fileName = doc.fileName;
    if (fileName && (
        fileName.includes('Debug Console') ||
        fileName.includes('Output') ||
        fileName.includes('REPL') ||
        fileName.includes('debug-console') ||
        fileName.toLowerCase().includes('console')
    )) {
        log(`[DebugConsoleDetection] Suppressing reading for console-like file: fileName=${fileName}`);
        return true;
    }

    return false;
}

/**
 * Check if the active editor is a debug console or suppressed panel
 */
export function isActiveEditorSuppressed(): boolean {
    const activeEditor = vscode.window.activeTextEditor;
    return shouldSuppressReading(activeEditor);
}

/**
 * Enhanced check that also considers VS Code's active view context
 */
export function shouldSuppressReadingEnhanced(editor?: vscode.TextEditor): boolean {
    // First check the basic suppression logic
    if (shouldSuppressReading(editor)) {
        return true;
    }

    // Additional context-based checks
    // Check if we're in debug mode (debugging session is active)
    if (vscode.debug.activeDebugSession) {
        // If debug session is active and we don't have a clear file editor, 
        // it might be debug console focused
        if (!editor || editor.document.uri.scheme !== 'file') {
            log(`[DebugConsoleDetection] Debug session active and no file editor - likely debug console`);
            return true;
        }
    }

    return false;
}
