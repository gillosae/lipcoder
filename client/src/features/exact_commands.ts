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
            '신택스 에러 리스트', '신텍스 에러리스트', '신택스 에러 목록', '문법 오류 목록', '문법 오류 리스트', '문법 에러 목록', '문법 에러 리스트',
            '신텍스 에러들', '신텍스 에러 목록', '문법 오류들', '문법 오류 목록', '문법 에러들', '문법 에러 목록', '신텍스 에러 리스트', '문법 오류 리스트',
            '오류 목록', '오류 리스트', '에러 목록', '에러 리스트', 'syntax error', 'syntax errors', '신택스 에러', '신텍스 에러'
        ], 
        command: 'lipcoder.syntaxErrorList', 
        feedback: 'Syntax error list', 
        type: 'navigation' 
    },
    { 
        patterns: [
            'fix errors', 'fix error', 'fix terminal errors', 'fix terminal error', 'auto fix errors', 'auto fix error',
            '에러 고쳐줘', '에러 고치기', '에러 수정', '에러 수정해줘', '오류 고쳐줘', '오류 고치기', '오류 수정', '오류 수정해줘',
            '터미널 에러 고쳐줘', '터미널 오류 고쳐줘', '에러를 고쳐줘', '오류를 고쳐줘', '자동으로 에러 고쳐줘', '자동으로 오류 고쳐줘'
        ], 
        command: 'lipcoder.fixTerminalErrors', 
        feedback: 'Fixing terminal errors', 
        type: 'action' 
    },
    { 
        patterns: [
            'explain error', 'explain errors', 'what is this error', 'what error', 'analyze error', 'analyze errors',
            '이게 무슨 에러야', '또 이게 무슨 에러야', '에러 설명', '에러 설명해줘', '오류 설명', '오류 설명해줘', '이거 무슨 에러야', '이거 무슨 오류야',
            '무슨 에러인지 설명해줘', '무슨 오류인지 설명해줘', '에러가 뭐야', '오류가 뭐야', '에러 분석', '오류 분석',
            '이 에러 뭐야', '이 오류 뭐야', '터미널 에러 설명', '터미널 오류 설명', '에러 자세히 설명해줘', '오류 자세히 설명해줘', '에러를 설명해', '에로를 설명해', '에로 설명', '애로 설명', '애로를 설명해', '이애로 설명해', '이 애로 설명해',
            '에러 설명', '오류 설명', '에러를 설명', '오류를 설명', '에러 뭐야', '오류 뭐야', '무슨 에러', '무슨 오류',
            'error explain', 'explain this error', 'what error is this', 'describe error', 'describe this error'
        ], 
        command: 'lipcoder.explainTerminalErrors', 
        feedback: 'Explaining terminal errors', 
        type: 'action' 
    },
    { 
        patterns: [
            'explain terminal output', 'explain output', 'what is this output', 'analyze output', 'describe output',
            '터미널 출력 설명해줘', '터미널 출력 설명', '출력 설명해줘', '출력 설명', '이 출력 뭐야', '이 출력이 뭐야',
            '터미널 출력이 뭐야', '터미널 출력 뭐야', '출력이 뭐야', '출력 뭐야', '출력 분석해줘', '출력 분석',
            '터미널 출력 분석해줘', '터미널 출력 분석', '이 출력 설명해줘', '이 출력 설명', '출력을 설명해줘', '출력을 설명',
            '터미널 출력을 설명해줘', '터미널 출력을 설명', '무슨 출력이야', '무슨 출력', '이게 무슨 출력이야', '이게 무슨 출력',
            '터미널에서 뭐가 나왔어', '터미널에서 뭐가 나왔나', '터미널 결과 설명해줘', '터미널 결과 설명',
            'terminal output explain', 'explain this output', 'what output is this', 'describe terminal output', 
            "실행 결과 설명해줘", "실행 결과 설명해", "실행 결과를 설명해줘", "실행 결과", "실행결과 설명해줘", "실행결과 설명",
            "결과 설명해줘", "결과 설명", "결과를 설명해줘", "결과를 설명", "결과 뭐야", "결과가 뭐야"
        ], 
        command: 'lipcoder.explainTerminalOutput', 
        feedback: 'Explaining terminal output', 
        type: 'action' 
    },
    { 
        patterns: [
            'run code', 'execute code', 'run current file', 'execute current file', 'run this file', 'execute this file',
            '코드 실행해줘', '코드 실행', '실행해줘', '실행', '현재 파일 실행', '현재 파일 실행해줘', 
            '이 파일 실행해줘', '이 파일 실행', '이 코드 실행해줘', '이 코드 실행', '파일 실행해줘', '파일 실행',
            '코드를 실행해줘', '코드를 실행', '현재 코드 실행', '현재 코드 실행해줘',
            '파일을 실행해줘', '파일을 실행', '이 파일을 실행해줘', '이 파일을 실행', '현재 파일을 실행해줘', '현재 파일을 실행',
            '지금 파일 실행해줘', '지금 파일 실행', '지금 코드 실행해줘', '지금 코드 실행', '지금 실행해줘', '지금 실행',
            '파일 실행', '코드 실행', '실행', '이 파일 실행', '현재 파일 실행', '지금 실행',
            'run file', 'execute file', 'run this', 'execute this', 'run current', 'execute current',
            '파일실행해줘', '코드실행해줘', '이파일실행해줘', '현재파일실행해줘', '파일실행', '코드실행'
        ], 
        command: 'lipcoder.executeCurrentFile', 
        feedback: 'Executing current file', 
        type: 'action' 
    },
    { 
        patterns: ['go to editor', 'editor', 'go editor', '코드 창', '코드 창', '코드 창으로 가', '코드 창 열기', '코드 창 열기', '코드 창 열어', '코드 창으로 가', '코드 창', '에디터', '에디터로 가', '에디터 창 열어', '에디터로가'], 
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
        patterns: ['go to explorer', 'explorer', 'go explorer', '탐색기로 가', '탐색기', '탐색기 열어', '탐색기 창 열어', '탐색기으로 가', '파일 탐색기', '파일 탐색기로 가'], 
        command: 'workbench.view.explorer', 
        feedback: 'In explorer', 
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
        patterns: ['open file readme', 'open readme', 'readme', 'readme 열어', 'readme 파일 열어', 'readme 파일 열기', 'readme 열기', '리드미 열어', '리드미 파일 열어', '리드미 열기', "리듬이 열어줘", "리듬이 열어"], 
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
    
    // File type opening commands
    { 
        patterns: [
            'open python file', 'python file', 'python 파일 열어', 'python 파일 열기', '파이썬 파일 열어', '파이썬 파일 열기', '파이썬 파일', 'python 파일',
            '파이썬 파일 열어줘', 'python 파일 열어줘', '파이썬 파일을 열어', 'python 파일을 열어', '파이썬 파일을 열어줘', 'python 파일을 열어줘', "파이손 파일 열어", "파이선 파일 열어", "파이선 파일 열어줘", "파이손 파일 열어줘"
        ], 
        command: 'lipcoder.openFileByType', 
        feedback: 'Opening Python file', 
        type: 'action' 
    },
    { 
        patterns: [
            'open markdown file', 'markdown file', 'md file', 'markdown 파일 열어', 'markdown 파일 열기', '마크다운 파일 열어', '마크다운 파일 열기', '마크다운 파일', 'markdown 파일',
            '마크다운 파일 열어줘', 'markdown 파일 열어줘', '마크다운 파일을 열어', 'markdown 파일을 열어', '마크다운 파일을 열어줘', 'markdown 파일을 열어줘',
            'md 파일 열어', 'md 파일 열기', 'md 파일', 'md 파일 열어줘', 'md 파일을 열어', 'md 파일을 열어줘'
        ], 
        command: 'lipcoder.openFileByType', 
        feedback: 'Opening Markdown file', 
        type: 'action' 
    },
    { 
        patterns: [
            'open image file', 'image file', 'picture file', '이미지 파일 열어', '이미지 파일 열기', '그림 파일 열어', '그림 파일 열기', '이미지 파일', '그림 파일',
            '이미지 파일 열어줘', '그림 파일 열어줘', '이미지 파일을 열어', '그림 파일을 열어', '이미지 파일을 열어줘', '그림 파일을 열어줘',
            'jpg 파일 열어', 'jpeg 파일 열어', 'png 파일 열어', 'gif 파일 열어', 'webp 파일 열어',
            'jpg 파일', 'jpeg 파일', 'gif 파일', 'webp 파일'
        ], 
        command: 'lipcoder.openFileByType', 
        feedback: 'Opening image file', 
        type: 'action' 
    },
    { 
        patterns: [
            'open javascript file', 'javascript file', 'js file', 'javascript 파일 열어', 'javascript 파일 열기', '자바스크립트 파일 열어', '자바스크립트 파일 열기', 
            '자바스크립트 파일', 'javascript 파일', 'js 파일', 'js 파일 열어', 'js 파일 열기',
            '자바스크립트 파일 열어줘', 'javascript 파일 열어줘', 'js 파일 열어줘', '자바스크립트 파일을 열어', 'javascript 파일을 열어', 'js 파일을 열어'
        ], 
        command: 'lipcoder.openFileByType', 
        feedback: 'Opening JavaScript file', 
        type: 'action' 
    },
    { 
        patterns: [
            'open typescript file', 'typescript file', 'ts file', 'typescript 파일 열어', 'typescript 파일 열기', '타입스크립트 파일 열어', '타입스크립트 파일 열기',
            '타입스크립트 파일', 'typescript 파일', 'ts 파일', 'ts 파일 열어', 'ts 파일 열기',
            '타입스크립트 파일 열어줘', 'typescript 파일 열어줘', 'ts 파일 열어줘', '타입스크립트 파일을 열어', 'typescript 파일을 열어', 'ts 파일을 열어'
        ], 
        command: 'lipcoder.openFileByType', 
        feedback: 'Opening TypeScript file', 
        type: 'action' 
    },
    { 
        patterns: [
            'open json file', 'json file', 'json 파일 열어', 'json 파일 열기', 'json 파일', 
            'json 파일 열어줘', 'json 파일을 열어', 'json 파일을 열어줘'
        ], 
        command: 'lipcoder.openFileByType', 
        feedback: 'Opening JSON file', 
        type: 'action' 
    },
    { 
        patterns: [
            'open html file', 'html file', 'html 파일 열어', 'html 파일 열기', 'html 파일',
            'html 파일 열어줘', 'html 파일을 열어', 'html 파일을 열어줘'
        ], 
        command: 'lipcoder.openFileByType', 
        feedback: 'Opening HTML file', 
        type: 'action' 
    },
    { 
        patterns: [
            'open css file', 'css file', 'css 파일 열어', 'css 파일 열기', 'css 파일',
            'css 파일 열어줘', 'css 파일을 열어', 'css 파일을 열어줘'
        ], 
        command: 'lipcoder.openFileByType', 
        feedback: 'Opening CSS file', 
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
    
    // Stop all audio and functions command - 점 명령어
    { 
        patterns: ['.', '점'], 
        command: 'lipcoder.stopAllAudio', 
        feedback: 'Stopped', 
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
    
    log(`[ExactCommands] Checking exact command for: "${normalizedText}"`);
    
    // Check for exact matches
    for (const cmd of EXACT_COMMANDS) {
        // Log which patterns we're checking for debugging
        if (cmd.command === 'lipcoder.explainTerminalErrors' || cmd.command === 'lipcoder.executeCurrentFile') {
            log(`[ExactCommands] Checking ${cmd.command} patterns against "${normalizedText}"`);
            log(`[ExactCommands] Available patterns for ${cmd.command}: ${JSON.stringify(cmd.patterns.slice(0, 10))}...`);
            
            // Check each pattern individually for debugging
            for (const pattern of cmd.patterns) {
                if (pattern === normalizedText) {
                    log(`[ExactCommands] MATCH FOUND: "${pattern}" === "${normalizedText}"`);
                    break;
                } else if (pattern.includes('파일') || pattern.includes('실행')) {
                    log(`[ExactCommands] No match: "${pattern}" !== "${normalizedText}"`);
                }
            }
        }
        
        const matchingPattern = cmd.patterns.find(pattern => normalizedText === pattern);
        if (matchingPattern) {
            try {
                log(`[ExactCommands] Executing exact command: ${cmd.command} (matched pattern: "${matchingPattern}")`);
                
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
                } else if (cmd.command === 'lipcoder.openFileByType') {
                    // Extract file type from the pattern
                    let fileType = '';
                    if (cmd.patterns.some(p => p.includes('python') || p.includes('파이썬'))) {
                        fileType = 'python';
                    } else if (cmd.patterns.some(p => p.includes('markdown') || p.includes('마크다운') || p.includes('md'))) {
                        fileType = 'markdown';
                    } else if (cmd.patterns.some(p => p.includes('image') || p.includes('이미지') || p.includes('그림') || p.includes('picture') || p.includes('jpg') || p.includes('jpeg') || p.includes('png') || p.includes('gif') || p.includes('webp'))) {
                        fileType = 'image';
                    } else if (cmd.patterns.some(p => p.includes('javascript') || p.includes('자바스크립트') || p.includes('js'))) {
                        fileType = 'javascript';
                    } else if (cmd.patterns.some(p => p.includes('typescript') || p.includes('타입스크립트') || p.includes('ts'))) {
                        fileType = 'typescript';
                    } else if (cmd.patterns.some(p => p.includes('json'))) {
                        fileType = 'json';
                    } else if (cmd.patterns.some(p => p.includes('html'))) {
                        fileType = 'html';
                    } else if (cmd.patterns.some(p => p.includes('css'))) {
                        fileType = 'css';
                    }
                    
                    if (fileType) {
                        await vscode.commands.executeCommand(cmd.command, fileType);
                    } else {
                        await vscode.commands.executeCommand(cmd.command);
                    }
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
    
    log(`[ExactCommands] No exact command match found for: "${normalizedText}"`);
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
