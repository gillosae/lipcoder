import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { crashLogger } from '../crash_logger';
import { log, logSuccess, logError } from '../utils';

export function registerCrashReporter(context: vscode.ExtensionContext) {
    // 로그 디렉토리 열기 명령어
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.openLogDirectory', async () => {
            try {
                const logDir = crashLogger.getLogDirectory();
                
                // 로그 디렉토리가 존재하는지 확인
                if (!fs.existsSync(logDir)) {
                    vscode.window.showWarningMessage('로그 디렉토리가 존재하지 않습니다.');
                    return;
                }
                
                // 파일 탐색기에서 로그 디렉토리 열기
                const uri = vscode.Uri.file(logDir);
                await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
                
                logSuccess(`[CrashReporter] Opened log directory: ${logDir}`);
                vscode.window.showInformationMessage(`로그 디렉토리를 열었습니다: ${logDir}`);
            } catch (error) {
                logError(`[CrashReporter] Failed to open log directory: ${error}`);
                vscode.window.showErrorMessage('로그 디렉토리를 여는데 실패했습니다.');
            }
        })
    );

    // 크래시 로그 보기 명령어
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.viewCrashLogs', async () => {
            try {
                const logDir = crashLogger.getLogDirectory();
                const crashLogFile = path.join(logDir, 'crash.log');
                
                if (!fs.existsSync(crashLogFile)) {
                    vscode.window.showInformationMessage('크래시 로그가 없습니다. 좋은 소식입니다!');
                    return;
                }
                
                // 크래시 로그 파일 열기
                const document = await vscode.workspace.openTextDocument(crashLogFile);
                await vscode.window.showTextDocument(document);
                
                logSuccess(`[CrashReporter] Opened crash log: ${crashLogFile}`);
            } catch (error) {
                logError(`[CrashReporter] Failed to open crash log: ${error}`);
                vscode.window.showErrorMessage('크래시 로그를 여는데 실패했습니다.');
            }
        })
    );

    // 디버그 로그 보기 명령어
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.viewDebugLogs', async () => {
            try {
                const logDir = crashLogger.getLogDirectory();
                const debugLogFile = path.join(logDir, 'debug.log');
                
                if (!fs.existsSync(debugLogFile)) {
                    vscode.window.showInformationMessage('디버그 로그가 없습니다.');
                    return;
                }
                
                // 디버그 로그 파일 열기
                const document = await vscode.workspace.openTextDocument(debugLogFile);
                await vscode.window.showTextDocument(document);
                
                logSuccess(`[CrashReporter] Opened debug log: ${debugLogFile}`);
            } catch (error) {
                logError(`[CrashReporter] Failed to open debug log: ${error}`);
                vscode.window.showErrorMessage('디버그 로그를 여는데 실패했습니다.');
            }
        })
    );

    // 성능 로그 보기 명령어
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.viewPerformanceLogs', async () => {
            try {
                const logDir = crashLogger.getLogDirectory();
                const perfLogFile = path.join(logDir, 'performance.log');
                
                if (!fs.existsSync(perfLogFile)) {
                    vscode.window.showInformationMessage('성능 로그가 없습니다.');
                    return;
                }
                
                // 성능 로그 파일 열기
                const document = await vscode.workspace.openTextDocument(perfLogFile);
                await vscode.window.showTextDocument(document);
                
                logSuccess(`[CrashReporter] Opened performance log: ${perfLogFile}`);
            } catch (error) {
                logError(`[CrashReporter] Failed to open performance log: ${error}`);
                vscode.window.showErrorMessage('성능 로그를 여는데 실패했습니다.');
            }
        })
    );

    // 로그 정리 명령어
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.clearLogs', async () => {
            try {
                const result = await vscode.window.showWarningMessage(
                    '모든 로그 파일을 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.',
                    { modal: true },
                    '삭제',
                    '취소'
                );
                
                if (result !== '삭제') {
                    return;
                }
                
                const logDir = crashLogger.getLogDirectory();
                const logFiles = ['crash.log', 'debug.log', 'performance.log', 'crash.log.old', 'debug.log.old', 'performance.log.old'];
                
                let deletedCount = 0;
                for (const logFile of logFiles) {
                    const filePath = path.join(logDir, logFile);
                    if (fs.existsSync(filePath)) {
                        fs.unlinkSync(filePath);
                        deletedCount++;
                    }
                }
                
                logSuccess(`[CrashReporter] Cleared ${deletedCount} log files`);
                vscode.window.showInformationMessage(`${deletedCount}개의 로그 파일을 삭제했습니다.`);
            } catch (error) {
                logError(`[CrashReporter] Failed to clear logs: ${error}`);
                vscode.window.showErrorMessage('로그 파일 삭제에 실패했습니다.');
            }
        })
    );

    // 로그 상태 확인 명령어
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.checkLogStatus', async () => {
            try {
                const logDir = crashLogger.getLogDirectory();
                const logFiles = ['crash.log', 'debug.log', 'performance.log'];
                
                let statusMessage = `로그 디렉토리: ${logDir}\n\n`;
                
                for (const logFile of logFiles) {
                    const filePath = path.join(logDir, logFile);
                    if (fs.existsSync(filePath)) {
                        const stats = fs.statSync(filePath);
                        const sizeKB = (stats.size / 1024).toFixed(2);
                        const modifiedTime = stats.mtime.toLocaleString();
                        statusMessage += `📄 ${logFile}: ${sizeKB}KB (수정: ${modifiedTime})\n`;
                    } else {
                        statusMessage += `📄 ${logFile}: 없음\n`;
                    }
                }
                
                // 메모리 사용량 추가
                const memUsage = process.memoryUsage();
                statusMessage += `\n💾 메모리 사용량:\n`;
                statusMessage += `  - Heap Used: ${(memUsage.heapUsed / 1024 / 1024).toFixed(2)}MB\n`;
                statusMessage += `  - Heap Total: ${(memUsage.heapTotal / 1024 / 1024).toFixed(2)}MB\n`;
                statusMessage += `  - RSS: ${(memUsage.rss / 1024 / 1024).toFixed(2)}MB\n`;
                statusMessage += `  - External: ${(memUsage.external / 1024 / 1024).toFixed(2)}MB`;
                
                vscode.window.showInformationMessage(statusMessage, { modal: true });
                logSuccess(`[CrashReporter] Displayed log status`);
            } catch (error) {
                logError(`[CrashReporter] Failed to check log status: ${error}`);
                vscode.window.showErrorMessage('로그 상태 확인에 실패했습니다.');
            }
        })
    );

    // 테스트 크래시 생성 명령어 (디버깅용)
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.testCrash', async () => {
            try {
                const result = await vscode.window.showWarningMessage(
                    '테스트용 크래시를 생성하시겠습니까? 이는 디버깅 목적으로만 사용해야 합니다.',
                    { modal: true },
                    '생성',
                    '취소'
                );
                
                if (result !== '생성') {
                    return;
                }
                
                // 의도적으로 에러 발생
                throw new Error('Test crash generated for debugging purposes');
            } catch (error) {
                logError(`[CrashReporter] Test crash generated: ${error}`);
                vscode.window.showErrorMessage('테스트 크래시가 생성되었습니다. 로그를 확인해보세요.');
            }
        })
    );

    log('[CrashReporter] Crash reporter commands registered');
}
