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
        patterns: ['go to explorer', 'explorer', 'go explorer', '탐색기', '탐색기 창', '탐색기로 가', '탐색기 열기', '탐색기 창 열기', '탐색기 창 열어', '익스플로러로 가', '익스플로러'], 
        command: 'workbench.view.explorer', 
        feedback: 'In explorer', 
        type: 'navigation' 
    },
    { 
        patterns: ['go to editor', 'editor', 'go editor', '코드 창', '코드 창', '코드 창으로 가', '코드 창 열기', '코드 창 열기', '코드 창 열어', '코드 창으로 가', '코드 창', '에디터', '에디터로 가', '에디터 창 열어'], 
        command: 'workbench.action.focusActiveEditorGroup', 
        feedback: 'In editor', 
        type: 'navigation' 
    },
    { 
        patterns: ['go to terminal', 'terminal', 'go terminal', '터미널로 가', '터미널', '터미널 열어', '터미널 창 열어', '터미널으로 가'], 
        command: 'workbench.action.terminal.focus', 
        feedback: 'In terminal', 
        type: 'navigation' 
    },
    { 
        patterns: ['go to problems', 'problems', 'go problems', '문제 창', '문제 창으로 가', '문제 창 열기', '문제 창 가', '문제 창 열어'], 
        command: 'workbench.actions.view.problems', 
        feedback: 'In problems', 
        type: 'navigation' 
    },
    { 
        patterns: ['go to output', 'output', 'go output', '아웃풋 창', '아웃풋 창으로 가', '아웃풋 창 열기', '아웃풋 창 열기', '아웃풋 창 가', '아웃풋 창 열어'], 
        command: 'workbench.action.output.toggleOutput', 
        feedback: 'In output', 
        type: 'navigation' 
    },
    
    // File operations
    { 
        patterns: ['save', 'save file', '저장', '파일 저장', '파일 저장하기', '파일 저장해'], 
        command: 'workbench.action.files.save', 
        feedback: 'Saved', 
        type: 'action' 
    },
    { 
        patterns: ['format', 'format document', '포맷', '포맷해', '포맷팅', '포맷팅해'], 
        command: 'editor.action.formatDocument', 
        feedback: 'Formatted', 
        type: 'action' 
    },
    { 
        patterns: ['copy', 'copy line', '복사', '복사하기', '복사해'], 
        command: 'editor.action.clipboardCopyAction', 
        feedback: 'Copied', 
        type: 'action' 
    },
    { 
        patterns: ['paste', 'paste line', '붙여넣기', '붙여넣기하기', '붙여넣기해', '붙여넣어'], 
        command: 'editor.action.clipboardPasteAction', 
        feedback: 'Pasted', 
        type: 'action' 
    },
    { 
        patterns: ['delete line', '이 줄 삭제', '이 줄 삭제하기', '이 줄을 삭제해', '줄 삭제', '줄 삭제하기', '줄 삭제해'], 
        command: 'editor.action.deleteLines', 
        feedback: 'Deleted', 
        type: 'action' 
    },
    { 
        patterns: ['close tab', 'close file', '탭 닫기', '탭을 닫아줘', '탭 닫아줘', '탭 닫어', '탭 닫아', '파일 닫아', '파일 닫아줘', '파일 닫기'], 
        command: 'workbench.action.closeActiveEditor', 
        feedback: 'Closed', 
        type: 'action' 
    },
    
    // LipCoder specific commands
    { 
        patterns: ['function list', '함수 리스트', 'show function list', 'navigate function list', 'function list navigation', '함수 리스트 보여줘'], 
        command: 'lipcoder.functionList', 
        feedback: 'Function list', 
        type: 'navigation' 
    },
    { 
        patterns: ['symbol tree', 'symbol tree navigation', 'symbol tree 내비게이션', 'symbol tree 내비게이션 보여줘', 'symbol tree 내비게이션 보여줘', '심볼 트리', '심볼 트리 보여줘', '심볼 트리 내비게이션', '심볼 트리 내비게이션 보여줘', '심볼 트리 내비게이션 보여줘'], 
        command: 'lipcoder.symbolTree', 
        feedback: 'Symbol tree', 
        type: 'navigation' 
    },
    { 
        patterns: ['breadcrumb', 'breadcrumb navigation', 'breadcrumb 내비게이션', 'breadcrumb 내비게이션 보여줘', 'breadcrumb 내비게이션 보여줘', '브레드크럼', '브레드크럼 보여줘', '브레드크럼 내비게이션', '브레드크럼 내비게이션 보여줘'], 
        command: 'lipcoder.breadcrumb', 
        feedback: 'Breadcrumb', 
        type: 'navigation' 
    },
    { 
        patterns: ['where am i', '지금 위치는', '지금 위치는?', '내가 지금 어디에 있지?', '지금 어디야', '지금 어디야?', '지금 위치 어디야?'], 
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
