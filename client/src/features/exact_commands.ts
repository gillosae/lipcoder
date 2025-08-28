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
        patterns: [
            'syntax error list', 'list syntax errors', 'show syntax errors', 'error list', 'list errors', 'show errors',
            '신택스 에러 리스트', '신택스 에러 목록', '문법 오류 목록', '문법 오류 리스트', '문법 에러 목록', '문법 에러 리스트',
            '신텍스 에러들', '신텍스 에러 목록', '문법 오류들', '문법 오류 목록', '문법 에러들', '문법 에러 목록', '신텍스 에러 리스트', '문법 오류 리스트',
            '오류 목록', '오류 리스트', '에러 목록', '에러 리스트', 'syntax error', 'syntax errors', '신택스 에러', '신텍스 에러'
        ], 
        command: 'lipcoder.syntaxErrorList', 
        feedback: 'Syntax error list', 
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
        command: 'lipcoder.smartGoToTerminal', 
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
        patterns: ['function list', '함수 리스트', '함수리스트', 'functionlist', 'show function list', 'navigate function list', 'function list navigation', '함수 리스트 보여줘'], 
        command: 'lipcoder.functionList', 
        feedback: 'Function list', 
        type: 'navigation' 
    },
    { 
        patterns: ['symbol tree', 'symbol tree navigation', 'symbol tree 내비게이션', 'symbol tree 내비게이션 보여줘', 'symbol tree 내비게이션 보여줘', '심볼 트리', '심볼트리', '심볼트리 보여줘', '심볼 트리 보여줘', '심볼 트리 내비게이션', '심볼 트리 내비게이션 보여줘', '심볼 트리 내비게이션 보여줘'], 
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
    { 
        patterns: ['which line', 'which line?', '몇번째 줄이야', '몇번째 줄이야?', '몇번째 줄이요?', '몇 번째 줄이야', '몇 번째 줄이야?', '지금 몇번째 줄이야?', '지금 몇 번째 줄이야?', 'line number', 'current line number'], 
        command: 'lipcoder.readCurrentLine', 
        feedback: 'Current line', 
        type: 'action' 
    },
    
    // File opening commands
    { 
        patterns: ['open file readme', 'open readme', 'readme', 'readme 열어', 'readme 파일 열어', 'readme 파일 열기', 'readme 열기', '리드미 열어', '리드미 파일 열어', '리드미 열기'], 
        command: 'lipcoder.openFile', 
        feedback: 'Opening README', 
        type: 'action' 
    },
    { 
        patterns: ['open university file', 'open university', 'university file', 'university', '유니버시티 파일 열어', '유니버시티 파일을 열어', '유니버시티 열어', '유니버시티 파일 열기', '유니버시티 파일을 열어줘', '유니버시티 열어줘', '유니버시티 파일 열어줘'], 
        command: 'lipcoder.openFile', 
        feedback: 'Opening university file', 
        type: 'action' 
    },
    { 
        patterns: ['open generated png', 'open png', 'open png file', 'generated png', 'png 열어', 'png 파일 열어', 'png 파일 열기', 'png 열기', '생성된 png', '생성된 png 열어', '생성된 png 파일 열어'], 
        command: 'lipcoder.openPngFile', 
        feedback: 'Opening PNG file', 
        type: 'action' 
    },
    
    // TTS Backend switching commands
    { 
        patterns: [
            'switch to macos tts', 'use macos tts', 'macos tts', 'macos voice', 'native macos tts', 'system tts',
            'macOS TTS로 바꿔', 'macOS TTS 사용', 'macOS 음성', '맥OS TTS', '맥OS 음성', '시스템 TTS', '네이티브 TTS'
        ], 
        command: 'lipcoder.switchToMacOS', 
        feedback: 'Switched to macOS TTS', 
        type: 'action' 
    },
    { 
        patterns: [
            'switch to macos gpt', 'use macos gpt', 'macos plus gpt', 'macos and gpt', 'macos gpt tts',
            'macOS GPT로 바꿔', 'macOS GPT 사용', 'macOS 플러스 GPT', 'macOS와 GPT', 'macOS GPT TTS'
        ], 
        command: 'lipcoder.switchToMacOSGPT', 
        feedback: 'Switched to macOS + GPT TTS', 
        type: 'action' 
    },
    { 
        patterns: [
            'select tts backend', 'choose tts backend', 'tts backend', 'switch tts backend', 'change tts backend',
            'TTS 백엔드 선택', 'TTS 백엔드 바꿔', 'TTS 백엔드 변경', 'TTS 엔진 선택', 'TTS 엔진 바꿔'
        ], 
        command: 'lipcoder.selectTTSBackend', 
        feedback: 'TTS backend selector', 
        type: 'action' 
    },
    { 
        patterns: [
            'tts status', 'show tts status', 'current tts backend', 'tts backend status',
            'TTS 상태', 'TTS 상태 보여줘', '현재 TTS 백엔드', 'TTS 백엔드 상태'
        ], 
        command: 'lipcoder.showTTSStatus', 
        feedback: 'TTS status', 
        type: 'action' 
    },
    
    // Vibe Coding commands
    { 
        patterns: ['accept', 'accept changes', 'apply changes', 'yes', 'confirm', '승인', '변경 승인', '변경 적용', '적용', '확인', '네', '예'], 
        command: 'lipcoder.acceptVibeCodingChange', 
        feedback: 'Changes accepted', 
        type: 'action' 
    },
    { 
        patterns: ['reject', 'reject changes', 'discard changes', 'no', 'cancel', '거부', '변경 거부', '변경 취소', '취소', '아니오', '아니'], 
        command: 'lipcoder.rejectVibeCodingChange', 
        feedback: 'Changes rejected', 
        type: 'action' 
    },
    
    // Image description commands
    { 
        patterns: [
            // Basic description commands
            'describe this image', 'describe image', 'analyze image', 'what is in this image', 'explain image',
            '이 그림에 대해 설명해', '이 그림 설명해', '이미지 설명해', '그림 설명해', '이 이미지 설명해',
            '이 그림에 대해 설명해줘', '이 그림 설명해줘', '이미지 설명해줘', '그림 설명해줘', '이 이미지 설명해줘',
            '이 그림 분석해', '이미지 분석해', '그림 분석해', '이 이미지 분석해',
            '이 그림 뭐야', '이미지 뭐야', '그림 뭐야', '이 이미지 뭐야',
            '이 그림에 뭐가 있어', '이미지에 뭐가 있어', '그림에 뭐가 있어', '이 이미지에 뭐가 있어', 
            '그림 설명해줘', '그림을 설명해줘', '이 그림을 설명해', '이 그림을 설명해줘', '그림을 설명해', '그림 설명해', '그림에 대해 설명해', '그림에 대해 설명해줘',
            
            // Detailed questions about image content
            '그림에서 막대의 색이 각각 다르니', '그림에서 막대의 색이 각각 다른가', '그림에서 막대 색깔이 다르니',
            '이 이미지의 막대들이 색깔이 각각 다르니', '이 이미지의 막대들이 색깔이 각각 다른가', '이 이미지의 막대들 색깔이 다르니',
            '이미지의 막대들이 색깔이 각각 다르니', '이미지의 막대들이 색깔이 각각 다른가', '이미지의 막대들 색깔이 다르니',
            '그림에서 색깔이 어떻게 다르니', '그림에서 색깔이 어떻게 다른가', '그림에서 색상이 어떻게 다르니',
            '그림에서 뭐가 보이니', '그림에서 뭐가 보이는가', '그림에서 무엇이 보이니',
            '그림에서 어떤 색이 보이니', '그림에서 어떤 색깔이 보이니', '그림에서 어떤 색상이 보이니',
            '그림에서 몇 개가 있니', '그림에서 몇 개가 있는가', '그림에서 개수가 몇 개니',
            '그림에서 크기가 어떻게 다르니', '그림에서 크기가 어떻게 다른가', '그림에서 사이즈가 다르니',
            '그림에서 위치가 어디니', '그림에서 위치가 어디인가', '그림에서 어디에 있니',
            '그림에서 텍스트가 뭐라고 써있니', '그림에서 글자가 뭐라고 써있니', '그림에서 문자가 뭐라고 써있니',
            '그림에서 숫자가 뭐니', '그림에서 숫자가 뭔가', '그림에서 수치가 뭐니',
            '그림에서 패턴이 어떻게 되니', '그림에서 패턴이 어떤가', '그림에서 모양이 어떻게 되니',
            '그림에서 배경이 어떻게 되니', '그림에서 배경이 어떤가', '그림에서 뒷배경이 어떻게 되니',
            '그림에서 사람이 몇 명이니', '그림에서 사람이 몇 명인가', '그림에서 인물이 몇 명이니',
            '그림에서 동물이 뭐니', '그림에서 동물이 뭔가', '그림에서 어떤 동물이 있니',
            '그림에서 건물이 뭐니', '그림에서 건물이 뭔가', '그림에서 어떤 건물이 있니',
            '그림에서 차트가 뭘 보여주니', '그림에서 그래프가 뭘 보여주니', '그림에서 도표가 뭘 보여주니',
            '그림에서 트렌드가 어떻게 되니', '그림에서 경향이 어떻게 되니', '그림에서 추세가 어떻게 되니'
        ], 
        command: 'lipcoder.selectAndAnalyzeImage', 
        feedback: 'Analyzing image', 
        type: 'action' 
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
                
                // Special handling for file opening commands
                if (cmd.command === 'lipcoder.openFile') {
                    // Extract filename from the pattern
                    let filename = '';
                    if (cmd.patterns.some(p => p.includes('readme'))) {
                        filename = 'README.md';
                    } else if (cmd.patterns.some(p => p.includes('university') || p.includes('유니버시티'))) {
                        filename = 'university.py';
                    }
                    
                    if (filename) {
                        await vscode.commands.executeCommand(cmd.command, filename);
                    } else {
                        await vscode.commands.executeCommand(cmd.command);
                    }
                } else if (cmd.command === 'lipcoder.openPngFile') {
                    // Handle PNG file opening
                    await vscode.commands.executeCommand(cmd.command);
                } else {
                    await vscode.commands.executeCommand(cmd.command);
                }
                
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
    const lineMatch = normalizedText.match(/^(?:go to line|line|줄|라인|줄로 가|라인으로 가|줄로|라인으로|줄 번호|라인 번호)\s+(\d+)$/);
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
    patterns.push('go to line [number]', 'line [number]', '줄 [number]', '라인 [number]', '줄로 가 [number]', '라인으로 가 [number]');
    
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
    if (normalizedText.match(/^(?:go to line|line|줄|라인|줄로 가|라인으로 가|줄로|라인으로|줄 번호|라인 번호)\s+(\d+)$/)) {
        return true;
    }
    
    return false;
}
