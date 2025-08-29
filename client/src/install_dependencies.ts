import * as vscode from 'vscode';
import * as cp from 'child_process';
import { lipcoderLog } from './logger';
import { log, logWarning, logSuccess, logError } from './utils';

/**
 * Checks for and installs a given tool if missing.
 */
async function ensureToolAvailable(tool: string, installArgs: string[], friendlyName: string) {
    return new Promise<void>((resolve) => {
        const check = cp.spawn(tool, ['--version']);
        check.on('error', async () => {
            const choice = await vscode.window.showInformationMessage(
                `${friendlyName} is not installed. Install now?`,
                'Yes',
                'No'
            );
            if (choice === 'Yes') {
                lipcoderLog.appendLine(`Installing ${friendlyName}...`);
                const install = cp.spawn(installArgs[0], installArgs.slice(1), { stdio: 'inherit' });
                install.on('exit', (code) => {
                    if (code === 0) {
                        vscode.window.showInformationMessage(`${friendlyName} installed successfully.`);
                    } else {
                        vscode.window.showErrorMessage(`Failed to install ${friendlyName}.`);
                    }
                    resolve();
                });
            } else {
                resolve();
            }
        });
        check.on('exit', () => resolve());
    });
}

/**
 * Node.js 설치 확인 및 안내
 */
async function checkNodeJS(): Promise<boolean> {
    return new Promise((resolve) => {
        const check = cp.spawn('node', ['--version']);
        check.on('error', async () => {
            logWarning('⚠️ Node.js가 설치되어 있지 않습니다');
            
            const choice = await vscode.window.showErrorMessage(
                '🚨 Node.js가 설치되어 있지 않습니다!\n\n' +
                'LipCoder는 Node.js (버전 16.0 이상)가 필요합니다. 지금 설치하시겠습니까?',
                { modal: true },
                '🔧 자동 설치 (Homebrew)',
                '📖 수동 설치 가이드',
                '⏭️ 나중에'
            );
            
            if (choice === '🔧 자동 설치 (Homebrew)') {
                await installNodeJSWithHomebrew();
            } else if (choice === '📖 수동 설치 가이드') {
                await showNodeJSInstallGuide();
            }
            
            resolve(false);
        });
        check.on('exit', (code) => {
            if (code === 0) {
                // 버전 확인
                try {
                    const version = cp.execSync('node --version', { encoding: 'utf8' }).trim();
                    const versionNumber = parseFloat(version.replace('v', ''));
                    
                    if (versionNumber < 16.0) {
                        logWarning(`⚠️ Node.js ${version}이 설치되어 있지만 버전이 낮습니다 (권장: 16.0+)`);
                        vscode.window.showWarningMessage(
                            `Node.js ${version}이 설치되어 있지만 버전이 낮습니다.\n권장 버전: 16.0 이상\n\n업그레이드를 고려해보세요.`,
                            '업그레이드 가이드 보기'
                        ).then(choice => {
                            if (choice === '업그레이드 가이드 보기') {
                                showNodeJSInstallGuide();
                            }
                        });
                    } else {
                        logSuccess(`✅ Node.js ${version}이 설치되어 있습니다`);
                    }
                } catch (e) {
                    logWarning('⚠️ Node.js 버전을 확인할 수 없습니다');
                }
                resolve(true);
            } else {
                resolve(false);
            }
        });
    });
}

/**
 * Homebrew를 통한 Node.js 자동 설치
 */
async function installNodeJSWithHomebrew(): Promise<void> {
    // 먼저 Homebrew가 설치되어 있는지 확인
    const brewCheck = cp.spawn('brew', ['--version']);
    
    brewCheck.on('error', async () => {
        const choice = await vscode.window.showWarningMessage(
            'Homebrew가 설치되어 있지 않습니다. Homebrew를 먼저 설치하시겠습니까?',
            '설치',
            '취소'
        );
        
        if (choice === '설치') {
            await installHomebrew();
        }
        return;
    });
    
    brewCheck.on('exit', async (code) => {
        if (code === 0) {
            // Homebrew가 있으면 Node.js 설치
            vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "Node.js 설치 중...",
                cancellable: false
            }, async (progress) => {
                progress.report({ message: "Homebrew를 통해 Node.js를 설치하고 있습니다..." });
                
                const install = cp.spawn('brew', ['install', 'node'], { stdio: 'pipe' });
                
                install.on('exit', (installCode) => {
                    if (installCode === 0) {
                        vscode.window.showInformationMessage(
                            '🎉 Node.js가 성공적으로 설치되었습니다! VS Code를 재시작해주세요.'
                        );
                        logSuccess('✅ Node.js 설치 완료');
                    } else {
                        vscode.window.showErrorMessage(
                            '❌ Node.js 설치에 실패했습니다. 수동 설치를 시도해보세요.'
                        );
                        logError('❌ Node.js 설치 실패');
                    }
                });
                
                install.on('error', (error) => {
                    vscode.window.showErrorMessage(
                        `❌ Node.js 설치 중 오류가 발생했습니다: ${error.message}`
                    );
                    logError(`❌ Node.js 설치 오류: ${error.message}`);
                });
            });
        }
    });
}

/**
 * Homebrew 설치
 */
async function installHomebrew(): Promise<void> {
    vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Homebrew 설치 중...",
        cancellable: false
    }, async (progress) => {
        progress.report({ message: "Homebrew 설치 스크립트를 실행하고 있습니다..." });
        
        const installScript = '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"';
        const install = cp.exec(installScript, { timeout: 300000 }); // 5분 타임아웃
        
        install.on('exit', (code) => {
            if (code === 0) {
                vscode.window.showInformationMessage(
                    '🎉 Homebrew가 설치되었습니다! 이제 Node.js를 설치할 수 있습니다.'
                );
                logSuccess('✅ Homebrew 설치 완료');
            } else {
                vscode.window.showErrorMessage(
                    '❌ Homebrew 설치에 실패했습니다. 수동 설치를 시도해보세요.'
                );
                logError('❌ Homebrew 설치 실패');
            }
        });
        
        install.on('error', (error) => {
            vscode.window.showErrorMessage(
                `❌ Homebrew 설치 중 오류가 발생했습니다: ${error.message}`
            );
            logError(`❌ Homebrew 설치 오류: ${error.message}`);
        });
    });
}

/**
 * Node.js 수동 설치 가이드 표시
 */
async function showNodeJSInstallGuide(): Promise<void> {
    const message = `📖 Node.js 설치/업그레이드 가이드\n\n` +
                   `권장 버전: Node.js 16.0 이상\n\n` +
                   `방법 1: 공식 웹사이트 (가장 쉬움)\n` +
                   `• https://nodejs.org/ 에서 LTS 버전 다운로드\n` +
                   `• .pkg 파일을 실행하여 설치\n` +
                   `• 설치 후 터미널에서 'node --version' 확인\n\n` +
                   `방법 2: Homebrew (macOS 권장)\n` +
                   `• 터미널에서: brew install node\n` +
                   `• 업그레이드: brew upgrade node\n\n` +
                   `방법 3: nvm (개발자 권장)\n` +
                   `• curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash\n` +
                   `• 터미널 재시작 후: nvm install --lts\n` +
                   `• 버전 전환: nvm use 18 (또는 원하는 버전)\n\n` +
                   `설치 후 VS Code와 터미널을 재시작해주세요.`;
    
    const choice = await vscode.window.showInformationMessage(
        message,
        { modal: true },
        '🌐 공식 사이트 열기',
        '📋 터미널 명령어 복사',
        '✅ 확인'
    );
    
    if (choice === '🌐 공식 사이트 열기') {
        vscode.env.openExternal(vscode.Uri.parse('https://nodejs.org/'));
    } else if (choice === '📋 터미널 명령어 복사') {
        await vscode.env.clipboard.writeText('brew install node');
        vscode.window.showInformationMessage('Homebrew 설치 명령어가 클립보드에 복사되었습니다!');
    }
}

/**
 * Installs or prompts to install Black and Prettier.
 * 이제 Node.js 체크도 포함합니다.
 */
export async function installDependencies(): Promise<void> {
    log('🔧 필수 의존성 체크를 시작합니다...');
    
    // 1. Node.js 체크 (가장 중요)
    const nodeInstalled = await checkNodeJS();
    
    if (!nodeInstalled) {
        logWarning('⚠️ Node.js가 설치되지 않았습니다. 일부 기능이 제한될 수 있습니다.');
    }
    
    // 2. 기존 도구들 체크
    try {
        await ensureToolAvailable('black', ['pip', 'install', '--user', 'black'], 'Black');
        await ensureToolAvailable('prettier', ['npm', 'install', '-g', 'prettier'], 'Prettier');
        
        log('✅ 의존성 체크가 완료되었습니다');
    } catch (error) {
        logError(`❌ 의존성 체크 중 오류 발생: ${error}`);
    }
}
