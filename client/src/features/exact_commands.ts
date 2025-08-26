import * as vscode from 'vscode';
import { log } from '../utils';
import { ConversationalResponse } from '../conversational_asr';

export interface ExactCommand {
    patterns: string[];
    command: string;
    feedback: string;
    type: 'navigation' | 'action';
}

/**
 * Exact command definitions for fast execution without LLM processing
 */
export const EXACT_COMMANDS: ExactCommand[] = [
    // Navigation commands
    { 
        patterns: ['go to explorer', 'explorer', 'go explorer'], 
        command: 'workbench.view.explorer', 
        feedback: 'In explorer', 
        type: 'navigation' 
    },
    { 
        patterns: ['go to editor', 'editor', 'go editor'], 
        command: 'workbench.action.focusActiveEditorGroup', 
        feedback: 'In editor', 
        type: 'navigation' 
    },
    { 
        patterns: ['go to terminal', 'terminal', 'go terminal'], 
        command: 'workbench.action.terminal.focus', 
        feedback: 'In terminal', 
        type: 'navigation' 
    },
    { 
        patterns: ['go to problems', 'problems', 'go problems'], 
        command: 'workbench.actions.view.problems', 
        feedback: 'In problems', 
        type: 'navigation' 
    },
    { 
        patterns: ['go to output', 'output', 'go output'], 
        command: 'workbench.action.output.toggleOutput', 
        feedback: 'In output', 
        type: 'navigation' 
    },
    
    // File operations
    { 
        patterns: ['save', 'save file'], 
        command: 'workbench.action.files.save', 
        feedback: 'Saved', 
        type: 'action' 
    },
    { 
        patterns: ['format', 'format document'], 
        command: 'editor.action.formatDocument', 
        feedback: 'Formatted', 
        type: 'action' 
    },
    { 
        patterns: ['copy', 'copy line'], 
        command: 'editor.action.clipboardCopyAction', 
        feedback: 'Copied', 
        type: 'action' 
    },
    { 
        patterns: ['paste', 'paste line'], 
        command: 'editor.action.clipboardPasteAction', 
        feedback: 'Pasted', 
        type: 'action' 
    },
    { 
        patterns: ['delete line'], 
        command: 'editor.action.deleteLines', 
        feedback: 'Deleted', 
        type: 'action' 
    },
    { 
        patterns: ['close tab', 'close file'], 
        command: 'workbench.action.closeActiveEditor', 
        feedback: 'Closed', 
        type: 'action' 
    },
    
    // LipCoder specific commands
    { 
        patterns: ['function list'], 
        command: 'lipcoder.functionList', 
        feedback: 'Function list', 
        type: 'navigation' 
    },
    { 
        patterns: ['symbol tree'], 
        command: 'lipcoder.symbolTree', 
        feedback: 'Symbol tree', 
        type: 'navigation' 
    },
    { 
        patterns: ['breadcrumb'], 
        command: 'lipcoder.breadcrumb', 
        feedback: 'Breadcrumb', 
        type: 'navigation' 
    },
    { 
        patterns: ['where am i'], 
        command: 'lipcoder.whereAmI', 
        feedback: 'Location info', 
        type: 'navigation' 
    },
];

/**
 * Try to execute exact commands without LLM processing for speed
 */
export async function tryExactCommand(text: string): Promise<ConversationalResponse | null> {
    const normalizedText = text.toLowerCase().trim();
    
    // Check for exact matches
    for (const cmd of EXACT_COMMANDS) {
        if (cmd.patterns.some(pattern => normalizedText === pattern)) {
            try {
                log(`[ExactCommands] Executing exact command: ${cmd.command}`);
                await vscode.commands.executeCommand(cmd.command);
                
                return {
                    response: cmd.feedback,
                    actions: [], // No actions for exact commands
                    shouldSpeak: true
                };
            } catch (error) {
                log(`[ExactCommands] Exact command failed: ${error}`);
                return null; // Fall back to LLM processing
            }
        }
    }
    
    // Check for line navigation (go to line X)
    const lineMatch = normalizedText.match(/^(?:go to line|line)\s+(\d+)$/);
    if (lineMatch) {
        const lineNumber = parseInt(lineMatch[1]);
        try {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                const position = new vscode.Position(lineNumber - 1, 0);
                editor.selection = new vscode.Selection(position, position);
                editor.revealRange(new vscode.Range(position, position));
                
                log(`[ExactCommands] Navigated to line ${lineNumber}`);
                return {
                    response: `Line ${lineNumber}`,
                    actions: [],
                    shouldSpeak: true
                };
            }
        } catch (error) {
            log(`[ExactCommands] Line navigation failed: ${error}`);
        }
    }
    
    return null; // No exact command found, proceed with LLM
}

/**
 * Get all exact command patterns for documentation or help
 */
export function getAllExactCommandPatterns(): string[] {
    const patterns: string[] = [];
    
    for (const cmd of EXACT_COMMANDS) {
        patterns.push(...cmd.patterns);
    }
    
    // Add line navigation pattern
    patterns.push('go to line [number]', 'line [number]');
    
    return patterns.sort();
}

/**
 * Check if a text matches any exact command pattern
 */
export function isExactCommand(text: string): boolean {
    const normalizedText = text.toLowerCase().trim();
    
    // Check exact command patterns
    for (const cmd of EXACT_COMMANDS) {
        if (cmd.patterns.some(pattern => normalizedText === pattern)) {
            return true;
        }
    }
    
    // Check line navigation pattern
    if (normalizedText.match(/^(?:go to line|line)\s+(\d+)$/)) {
        return true;
    }
    
    return false;
}
