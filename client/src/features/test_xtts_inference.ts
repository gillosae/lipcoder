import * as vscode from 'vscode';
import { fetch, Agent } from 'undici';
import { log } from '../utils';
import { xttsV2Config } from '../config';
import { serverManager } from '../server_manager';

// Keep-alive agent for HTTP fetch to reuse connections
const keepAliveAgent = new Agent({ keepAliveTimeout: 60000 });

/**
 * XTTS 직접 테스트 기능 - Command Palette에서 사용
 */
export function registerTestXTTSInference(context: vscode.ExtensionContext) {
    
    // 1. 기본 XTTS 테스트 명령어
    const testXTTSCommand = vscode.commands.registerCommand('lipcoder.testXTTSInference', async () => {
        try {
            // 사용자로부터 텍스트 입력 받기
            const text = await vscode.window.showInputBox({
                prompt: 'XTTS로 합성할 텍스트를 입력하세요',
                placeHolder: '예: hello world, 안녕하세요, function, 변수명',
                value: 'hello world'
            });

            if (!text) {
                return;
            }

            // 언어 선택
            const languageOptions = [
                { label: '🇺🇸 English (en)', value: 'en' },
                { label: '🇰🇷 Korean (ko)', value: 'ko' },
                { label: '🤖 Auto-detect', value: 'auto' }
            ];

            const selectedLanguage = await vscode.window.showQuickPick(languageOptions, {
                placeHolder: '언어를 선택하세요'
            });

            if (!selectedLanguage) {
                return;
            }

            // 카테고리 선택
            const categoryOptions = [
                { label: '📝 Variable (변수명)', value: 'variable' },
                { label: '🔑 Keyword (키워드)', value: 'keyword' },
                { label: '💬 Comment (주석)', value: 'comment' },
                { label: '📄 Literal (리터럴)', value: 'literal' },
                { label: '⚡ Operator (연산자)', value: 'operator' },
                { label: '🏷️ Type (타입)', value: 'type' },
                { label: '📢 Narration (기본)', value: 'narration' }
            ];

            const selectedCategory = await vscode.window.showQuickPick(categoryOptions, {
                placeHolder: '음성 카테고리를 선택하세요'
            });

            if (!selectedCategory) {
                return;
            }

            await performXTTSTest(text, selectedLanguage.value, selectedCategory.value);

        } catch (error) {
            vscode.window.showErrorMessage(`XTTS 테스트 실패: ${error}`);
            log(`[testXTTSInference] Error: ${error}`);
        }
    });

    // 2. 빠른 영어 테스트
    const quickEnglishTest = vscode.commands.registerCommand('lipcoder.quickEnglishXTTS', async () => {
        const testPhrases = [
            'hello world',
            'function',
            'variable name',
            'return statement',
            'class definition'
        ];

        const selectedPhrase = await vscode.window.showQuickPick(testPhrases.map(phrase => ({
            label: phrase,
            value: phrase
        })), {
            placeHolder: '영어 테스트 문구를 선택하세요'
        });

        if (selectedPhrase) {
            await performXTTSTest(selectedPhrase.value, 'en', 'variable');
        }
    });

    // 3. 빠른 한국어 테스트
    const quickKoreanTest = vscode.commands.registerCommand('lipcoder.quickKoreanXTTS', async () => {
        const testPhrases = [
            '안녕하세요',
            '함수',
            '변수명',
            '반환문',
            '클래스 정의'
        ];

        const selectedPhrase = await vscode.window.showQuickPick(testPhrases.map(phrase => ({
            label: phrase,
            value: phrase
        })), {
            placeHolder: '한국어 테스트 문구를 선택하세요'
        });

        if (selectedPhrase) {
            await performXTTSTest(selectedPhrase.value, 'ko', 'variable');
        }
    });

    // 4. XTTS 서버 상태 확인
    const checkXTTSStatus = vscode.commands.registerCommand('lipcoder.checkXTTSStatus', async () => {
        try {
            const xttsPort = serverManager.getServerPort('xtts_v2');
            
            if (!xttsPort) {
                vscode.window.showWarningMessage('XTTS-v2 서버가 실행되지 않았습니다.');
                return;
            }

            const response = await fetch(`http://localhost:${xttsPort}/health`, {
                dispatcher: keepAliveAgent
            });
            
            if (response.ok) {
                const healthData = await response.json() as any;
                
                const statusMessage = [
                    `✅ XTTS 서버 상태: 정상`,
                    `🖥️ 디바이스: ${healthData.device}`,
                    `🤖 모델 로드됨: ${healthData.model_loaded}`,
                    `⚡ 직접 모델: ${healthData.direct_model_loaded}`,
                    `🗣️ 지원 언어: ${healthData.supported_languages?.join(', ')}`,
                    `💾 캐시된 음성: ${healthData.speaker_cache?.cached_embeddings || 0}개`
                ].join('\n');

                vscode.window.showInformationMessage(statusMessage, { modal: true });
                
                // 캐시 통계도 출력 채널에 로그
                log(`[XTTS Status] ${JSON.stringify(healthData, null, 2)}`);
                
            } else {
                vscode.window.showErrorMessage(`XTTS 서버 오류: ${response.status}`);
            }
            
        } catch (error) {
            vscode.window.showErrorMessage(`XTTS 서버 연결 실패: ${error}`);
        }
    });

    // 5. XTTS 캐시 클리어
    const clearXTTSCache = vscode.commands.registerCommand('lipcoder.clearXTTSCache', async () => {
        try {
            const xttsPort = serverManager.getServerPort('xtts_v2');
            
            if (!xttsPort) {
                vscode.window.showWarningMessage('XTTS-v2 서버가 실행되지 않았습니다.');
                return;
            }

            const confirm = await vscode.window.showWarningMessage(
                'XTTS 음성 캐시를 모두 삭제하시겠습니까?',
                { modal: true },
                '삭제',
                '취소'
            );

            if (confirm === '삭제') {
                const response = await fetch(`http://localhost:${xttsPort}/cache/clear`, {
                    method: 'POST',
                    dispatcher: keepAliveAgent
                });

                if (response.ok) {
                    vscode.window.showInformationMessage('✅ XTTS 캐시가 삭제되었습니다.');
                } else {
                    vscode.window.showErrorMessage(`캐시 삭제 실패: ${response.status}`);
                }
            }
            
        } catch (error) {
            vscode.window.showErrorMessage(`캐시 삭제 실패: ${error}`);
        }
    });

    context.subscriptions.push(
        testXTTSCommand,
        quickEnglishTest,
        quickKoreanTest,
        checkXTTSStatus,
        clearXTTSCache
    );
}

/**
 * XTTS 테스트 실행
 */
async function performXTTSTest(text: string, language: string, category: string): Promise<void> {
    const startTime = Date.now();
    
    try {
        log(`[XTTS Test] Starting synthesis: "${text}" (${language}, ${category})`);
        
        // 진행 상황 표시
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `XTTS 합성 중: "${text}"`,
            cancellable: false
        }, async (progress) => {
            
            progress.report({ increment: 20, message: '서버 연결 중...' });
            
            const xttsPort = serverManager.getServerPort('xtts_v2');
            if (!xttsPort) {
                throw new Error('XTTS-v2 서버가 실행되지 않았습니다.');
            }

            progress.report({ increment: 40, message: '음성 합성 중...' });

            // Fast endpoint 먼저 시도
            let response = await fetch(`http://localhost:${xttsPort}/tts_fast`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    text: text,
                    language: language,
                    category: category,
                    sample_rate: xttsV2Config.sampleRate
                }),
                dispatcher: keepAliveAgent
            });

            // Fast endpoint 실패시 일반 endpoint 시도
            if (!response.ok && response.status === 404) {
                log(`[XTTS Test] Fast endpoint not available, trying regular endpoint`);
                response = await fetch(`http://localhost:${xttsPort}/tts`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        text: text,
                        language: language,
                        category: category,
                        sample_rate: xttsV2Config.sampleRate
                    }),
                    dispatcher: keepAliveAgent
                });
            }

            progress.report({ increment: 80, message: '오디오 처리 중...' });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`HTTP ${response.status}: ${errorText}`);
            }

            const audioBuffer = await response.arrayBuffer();
            const audioSize = audioBuffer.byteLength;
            
            progress.report({ increment: 100, message: '완료!' });

            const elapsed = Date.now() - startTime;
            
            // 결과 저장 (선택사항)
            const saveAudio = await vscode.window.showInformationMessage(
                `✅ XTTS 합성 완료!\n` +
                `📝 텍스트: "${text}"\n` +
                `🌍 언어: ${language}\n` +
                `🎵 카테고리: ${category}\n` +
                `📊 크기: ${(audioSize / 1024).toFixed(1)}KB\n` +
                `⏱️ 시간: ${elapsed}ms`,
                '오디오 저장',
                '닫기'
            );

            if (saveAudio === '오디오 저장') {
                const fileName = `xtts_test_${language}_${category}_${text.replace(/[^a-zA-Z0-9가-힣]/g, '_')}.wav`;
                const saveUri = await vscode.window.showSaveDialog({
                    defaultUri: vscode.Uri.file(fileName),
                    filters: {
                        'Audio Files': ['wav']
                    }
                });

                if (saveUri) {
                    const fs = require('fs');
                    fs.writeFileSync(saveUri.fsPath, Buffer.from(audioBuffer));
                    vscode.window.showInformationMessage(`💾 오디오 저장됨: ${saveUri.fsPath}`);
                }
            }

            log(`[XTTS Test] Success: ${audioSize} bytes in ${elapsed}ms`);
        });

    } catch (error) {
        const elapsed = Date.now() - startTime;
        log(`[XTTS Test] Failed after ${elapsed}ms: ${error}`);
        
        vscode.window.showErrorMessage(
            `❌ XTTS 합성 실패\n` +
            `📝 텍스트: "${text}"\n` +
            `🌍 언어: ${language}\n` +
            `❗ 오류: ${error}`
        );
        
        throw error;
    }
}
