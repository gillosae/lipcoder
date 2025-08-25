import * as vscode from 'vscode';
import { log, logSuccess, logWarning } from '../utils';
import { openFileInRememberedTab } from './tab_tracker';

/**
 * Last Editor Tracker
 * 최근에 방문한 에디터를 추적하여 터미널에서 ASR 요청 시 사용할 수 있도록 함
 */

interface EditorInfo {
    editor: vscode.TextEditor;
    document: vscode.TextDocument;
    lastAccessTime: Date;
    filePath: string;
}

// 최근 방문한 에디터들을 저장 (최대 5개)
let recentEditors: EditorInfo[] = [];
let lastActiveEditor: vscode.TextEditor | undefined = undefined;

/**
 * 에디터 정보를 최근 목록에 추가/업데이트
 */
function updateRecentEditor(editor: vscode.TextEditor): void {
    if (!editor || !editor.document) {
        return;
    }

    const filePath = editor.document.uri.fsPath;
    const now = new Date();

    // 기존 항목이 있는지 확인
    const existingIndex = recentEditors.findIndex(info => info.filePath === filePath);
    
    if (existingIndex >= 0) {
        // 기존 항목 업데이트 및 맨 앞으로 이동
        recentEditors[existingIndex].lastAccessTime = now;
        recentEditors[existingIndex].editor = editor;
        recentEditors[existingIndex].document = editor.document;
        
        // 맨 앞으로 이동
        const [updated] = recentEditors.splice(existingIndex, 1);
        recentEditors.unshift(updated);
    } else {
        // 새 항목 추가
        const newInfo: EditorInfo = {
            editor,
            document: editor.document,
            lastAccessTime: now,
            filePath
        };
        
        recentEditors.unshift(newInfo);
        
        // 최대 5개까지만 유지
        if (recentEditors.length > 5) {
            recentEditors = recentEditors.slice(0, 5);
        }
    }

    lastActiveEditor = editor;
    log(`[LastEditorTracker] Updated recent editor: ${filePath}`);
}

/**
 * 가장 최근에 방문한 에디터 반환
 */
export function getLastActiveEditor(): vscode.TextEditor | undefined {
    // 현재 활성 에디터가 있으면 그것을 반환
    const currentActive = vscode.window.activeTextEditor;
    if (currentActive) {
        updateRecentEditor(currentActive);
        return currentActive;
    }

    // 활성 에디터가 없으면 최근 방문한 에디터 중에서 유효한 것을 찾아 반환
    for (const editorInfo of recentEditors) {
        try {
            // 에디터가 여전히 유효한지 확인
            if (editorInfo.editor && 
                !editorInfo.editor.document.isClosed && 
                editorInfo.document.uri.scheme !== 'untitled') {
                
                log(`[LastEditorTracker] Using last active editor: ${editorInfo.filePath}`);
                return editorInfo.editor;
            }
        } catch (error) {
            // 에디터가 더 이상 유효하지 않음
            log(`[LastEditorTracker] Editor no longer valid: ${editorInfo.filePath}`);
        }
    }

    // 유효한 에디터가 없으면 undefined 반환
    logWarning('[LastEditorTracker] No valid recent editor found');
    return undefined;
}

/**
 * 최근 방문한 에디터 목록 반환 (디버깅용)
 */
export function getRecentEditors(): EditorInfo[] {
    return [...recentEditors];
}

/**
 * 에디터 추적 초기화
 */
export function initializeEditorTracking(context: vscode.ExtensionContext): void {
    log('[LastEditorTracker] Initializing editor tracking...');

    // 에디터 변경 이벤트 리스너
    const onDidChangeActiveTextEditor = vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) {
            updateRecentEditor(editor);
        }
    });

    // 문서 열기 이벤트 리스너
    const onDidOpenTextDocument = vscode.workspace.onDidOpenTextDocument((document) => {
        // 현재 활성 에디터가 이 문서와 연결되어 있는지 확인
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor && activeEditor.document === document) {
            updateRecentEditor(activeEditor);
        }
    });

    // 에디터 선택 변경 이벤트 리스너 (커서 이동 등)
    const onDidChangeTextEditorSelection = vscode.window.onDidChangeTextEditorSelection((event) => {
        if (event.textEditor) {
            updateRecentEditor(event.textEditor);
        }
    });

    // 현재 활성 에디터가 있으면 초기화
    const currentActive = vscode.window.activeTextEditor;
    if (currentActive) {
        updateRecentEditor(currentActive);
    }

    // 이벤트 리스너들을 컨텍스트에 등록
    context.subscriptions.push(
        onDidChangeActiveTextEditor,
        onDidOpenTextDocument,
        onDidChangeTextEditorSelection
    );

    logSuccess('[LastEditorTracker] Editor tracking initialized');
}

/**
 * 에디터 추적 정리
 */
export function cleanupEditorTracking(): void {
    recentEditors = [];
    lastActiveEditor = undefined;
    log('[LastEditorTracker] Editor tracking cleaned up');
}

/**
 * Open a file using tab-aware logic - reopens in original tab if remembered
 */
export async function openFileTabAware(filePath: string): Promise<vscode.TextEditor | undefined> {
    try {
        log(`[LastEditorTracker] Opening file with tab awareness: ${filePath}`);
        const editor = await openFileInRememberedTab(filePath);
        
        if (editor) {
            updateRecentEditor(editor);
            logSuccess(`[LastEditorTracker] Successfully opened ${filePath} in remembered tab`);
        }
        
        return editor;
    } catch (error) {
        logWarning(`[LastEditorTracker] Failed to open file with tab awareness: ${error}`);
        return undefined;
    }
}

/**
 * Get the most recent editor and optionally open it in its remembered tab
 */
export async function getLastActiveEditorTabAware(openIfClosed: boolean = false): Promise<vscode.TextEditor | undefined> {
    // First try to get the current active editor
    const currentActive = vscode.window.activeTextEditor;
    if (currentActive) {
        updateRecentEditor(currentActive);
        return currentActive;
    }

    // If no active editor and we should try to reopen, try the most recent one
    if (openIfClosed && recentEditors.length > 0) {
        const mostRecent = recentEditors[0];
        log(`[LastEditorTracker] No active editor, attempting to reopen most recent: ${mostRecent.filePath}`);
        
        try {
            const editor = await openFileInRememberedTab(mostRecent.filePath);
            if (editor) {
                updateRecentEditor(editor);
                return editor;
            }
        } catch (error) {
            logWarning(`[LastEditorTracker] Failed to reopen most recent file: ${error}`);
        }
    }

    // Fall back to the original logic
    return getLastActiveEditor();
}

/**
 * 디버그 정보 출력
 */
export function debugEditorTracking(): void {
    log('[LastEditorTracker] === DEBUG INFO ===');
    log(`Recent editors count: ${recentEditors.length}`);
    log(`Last active editor: ${lastActiveEditor ? lastActiveEditor.document.uri.fsPath : 'none'}`);
    log(`Current active editor: ${vscode.window.activeTextEditor ? vscode.window.activeTextEditor.document.uri.fsPath : 'none'}`);
    
    recentEditors.forEach((info, index) => {
        log(`  ${index + 1}. ${info.filePath} (${info.lastAccessTime.toLocaleTimeString()})`);
    });
    log('[LastEditorTracker] === END DEBUG ===');
}
