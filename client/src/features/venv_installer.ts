import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { log, logError, logSuccess, logWarning } from '../utils';

/**
 * LipCoder 가상환경 기반 의존성 설치 시스템
 * 시스템 전역 패키지 대신 독립적인 가상환경을 생성하여 정확한 버전의 패키지들을 설치합니다.
 */

/**
 * 가상환경 경로 설정
 */
const VENV_PATH = path.join(__dirname, '..', '..', '..', 'server', 'lipcoder_venv');
const VENV_PYTHON = path.join(VENV_PATH, 'bin', 'python');
const VENV_PIP = path.join(VENV_PATH, 'bin', 'pip');
const REQUIREMENTS_FILE = path.join(__dirname, '..', '..', '..', 'server', 'requirements_lipcoder.txt');
const VENV_MARKER_FILE = path.join(VENV_PATH, '.lipcoder_venv_ready');

/**
 * 가상환경 존재 여부 확인
 */
function checkVenvExists(): boolean {
    return fs.existsSync(VENV_PATH) && fs.existsSync(VENV_PYTHON) && fs.existsSync(VENV_PIP);
}

/**
 * 가상환경이 완전히 설정되었는지 확인
 */
function checkVenvReady(): boolean {
    return checkVenvExists() && fs.existsSync(VENV_MARKER_FILE);
}

/**
 * Python 3 설치 여부 확인
 */
async function checkPython3(): Promise<boolean> {
    return new Promise((resolve) => {
        const process = cp.spawn('python3', ['--version'], { stdio: 'ignore' });
        process.on('error', () => resolve(false));
        process.on('exit', (code) => resolve(code === 0));
    });
}

/**
 * 가상환경 생성
 */
async function createVirtualEnvironment(): Promise<boolean> {
    log('🐍 Python 가상환경을 생성합니다...');
    
    return new Promise((resolve) => {
        const venvProcess = cp.spawn('python3', ['-m', 'venv', VENV_PATH], {
            stdio: ['ignore', 'pipe', 'pipe']
        });
        
        let output = '';
        let errorOutput = '';
        
        venvProcess.stdout?.on('data', (data) => {
            output += data.toString();
        });
        
        venvProcess.stderr?.on('data', (data) => {
            errorOutput += data.toString();
        });
        
        venvProcess.on('exit', (code) => {
            if (code === 0) {
                logSuccess('✅ 가상환경 생성 완료');
                resolve(true);
            } else {
                logError(`❌ 가상환경 생성 실패 (exit code: ${code})`);
                if (errorOutput) logError(`   stderr: ${errorOutput.trim()}`);
                resolve(false);
            }
        });
        
        venvProcess.on('error', (error) => {
            logError(`❌ 가상환경 생성 프로세스 오류: ${error.message}`);
            resolve(false);
        });
    });
}

/**
 * 가상환경에 pip 업그레이드
 */
async function upgradePip(): Promise<boolean> {
    log('📦 pip를 최신 버전으로 업그레이드합니다...');
    
    return new Promise((resolve) => {
        const pipProcess = cp.spawn(VENV_PYTHON, ['-m', 'pip', 'install', '--upgrade', 'pip'], {
            stdio: ['ignore', 'pipe', 'pipe']
        });
        
        let output = '';
        let errorOutput = '';
        
        pipProcess.stdout?.on('data', (data) => {
            output += data.toString();
        });
        
        pipProcess.stderr?.on('data', (data) => {
            errorOutput += data.toString();
        });
        
        pipProcess.on('exit', (code) => {
            if (code === 0) {
                logSuccess('✅ pip 업그레이드 완료');
                resolve(true);
            } else {
                logWarning(`⚠️ pip 업그레이드 실패, 하지만 계속 진행합니다 (exit code: ${code})`);
                resolve(true); // pip 업그레이드 실패해도 계속 진행
            }
        });
        
        pipProcess.on('error', (error) => {
            logWarning(`⚠️ pip 업그레이드 프로세스 오류, 하지만 계속 진행합니다: ${error.message}`);
            resolve(true);
        });
    });
}

/**
 * requirements.txt에서 패키지 설치
 */
async function installRequirements(): Promise<boolean> {
    log('📋 requirements.txt에서 패키지들을 설치합니다...');
    log(`📄 Requirements 파일: ${REQUIREMENTS_FILE}`);
    
    if (!fs.existsSync(REQUIREMENTS_FILE)) {
        logError(`❌ Requirements 파일을 찾을 수 없습니다: ${REQUIREMENTS_FILE}`);
        return false;
    }
    
    return new Promise((resolve) => {
        const installProcess = cp.spawn(VENV_PIP, ['install', '-r', REQUIREMENTS_FILE], {
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 300000 // 5분 타임아웃
        });
        
        let output = '';
        let errorOutput = '';
        
        installProcess.stdout?.on('data', (data) => {
            const text = data.toString();
            output += text;
            // 실시간으로 주요 설치 진행상황 로그
            if (text.includes('Installing') || text.includes('Successfully installed')) {
                log(`📦 ${text.trim()}`);
            }
        });
        
        installProcess.stderr?.on('data', (data) => {
            errorOutput += data.toString();
        });
        
        installProcess.on('exit', (code) => {
            if (code === 0) {
                logSuccess('✅ 모든 Python 패키지 설치 완료');
                resolve(true);
            } else {
                logError(`❌ 패키지 설치 실패 (exit code: ${code})`);
                if (errorOutput) logError(`   stderr: ${errorOutput.trim()}`);
                resolve(false);
            }
        });
        
        installProcess.on('error', (error) => {
            logError(`❌ 패키지 설치 프로세스 오류: ${error.message}`);
            resolve(false);
        });
        
        installProcess.on('timeout', () => {
            logError('⏰ 패키지 설치 타임아웃 (5분)');
            installProcess.kill();
            resolve(false);
        });
    });
}

/**
 * 가상환경 설정 완료 마커 생성
 */
function createVenvMarker(): void {
    const markerContent = {
        created: new Date().toISOString(),
        python_version: process.version,
        lipcoder_version: '1.0.0'
    };
    
    fs.writeFileSync(VENV_MARKER_FILE, JSON.stringify(markerContent, null, 2));
    logSuccess('✅ 가상환경 설정 완료 마커 생성');
}

/**
 * 가상환경 테스트
 */
async function testVirtualEnvironment(): Promise<boolean> {
    log('🧪 가상환경 패키지 설치 상태를 테스트합니다...');
    
    const testPackages = ['flask', 'torch', 'numpy', 'soundfile'];
    
    for (const pkg of testPackages) {
        const testResult = await new Promise<boolean>((resolve) => {
            const testProcess = cp.spawn(VENV_PYTHON, ['-c', `import ${pkg}; print("${pkg} OK")`], {
                stdio: ['ignore', 'pipe', 'pipe']
            });
            
            testProcess.on('exit', (code) => resolve(code === 0));
            testProcess.on('error', () => resolve(false));
        });
        
        if (testResult) {
            logSuccess(`✅ ${pkg} 테스트 통과`);
        } else {
            logError(`❌ ${pkg} 테스트 실패`);
            return false;
        }
    }
    
    logSuccess('✅ 모든 핵심 패키지 테스트 통과');
    return true;
}

/**
 * 전체 가상환경 설정 프로세스
 */
export async function setupVirtualEnvironment(): Promise<boolean> {
    const platform = os.platform();
    
    if (platform !== 'darwin') {
        vscode.window.showWarningMessage(
            '🍎 LipCoder는 현재 macOS에서만 완전히 지원됩니다.'
        );
        return false;
    }
    
    log('🚀 LipCoder 가상환경 설정을 시작합니다...');
    
    // 1. Python3 확인
    const python3Available = await checkPython3();
    if (!python3Available) {
        vscode.window.showErrorMessage(
            '❌ Python 3가 설치되어 있지 않습니다. 먼저 Python 3를 설치해주세요.',
            'Python 설치 가이드'
        ).then(selection => {
            if (selection === 'Python 설치 가이드') {
                vscode.env.openExternal(vscode.Uri.parse('https://www.python.org/downloads/'));
            }
        });
        return false;
    }
    
    // 2. 기존 가상환경 확인
    if (checkVenvReady()) {
        log('✅ LipCoder 가상환경이 이미 설정되어 있습니다');
        return true;
    }
    
    // 3. 사용자에게 설치 확인
    const userChoice = await vscode.window.showInformationMessage(
        '🐍 LipCoder 전용 Python 가상환경을 생성하고 필요한 패키지들을 설치하시겠습니까?\\n\\n' +
        '설치될 패키지:\\n' +
        '• Flask, Uvicorn (웹 서버)\\n' +
        '• PyTorch, TTS (AI/음성 합성)\\n' +
        '• NumPy, SoundFile (오디오 처리)\\n\\n' +
        '⏱️ 설치 시간: 약 3-5분 (인터넷 속도에 따라 다름)',
        { modal: true },
        '✅ 설치 시작',
        '❌ 취소'
    );
    
    if (userChoice !== '✅ 설치 시작') {
        log('❌ 사용자가 가상환경 설치를 취소했습니다');
        return false;
    }
    
    // 4. 진행 상황 표시와 함께 설치 실행
    return vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "LipCoder 가상환경 설정",
        cancellable: false
    }, async (progress) => {
        try {
            // 기존 가상환경 제거 (있다면)
            if (fs.existsSync(VENV_PATH)) {
                progress.report({ message: "기존 가상환경 제거 중..." });
                fs.rmSync(VENV_PATH, { recursive: true, force: true });
                log('🗑️ 기존 가상환경 제거 완료');
            }
            
            // 가상환경 생성
            progress.report({ message: "Python 가상환경 생성 중...", increment: 10 });
            const venvCreated = await createVirtualEnvironment();
            if (!venvCreated) {
                throw new Error('가상환경 생성 실패');
            }
            
            // pip 업그레이드
            progress.report({ message: "pip 업그레이드 중...", increment: 20 });
            await upgradePip();
            
            // 패키지 설치
            progress.report({ message: "Python 패키지 설치 중... (3-5분 소요)", increment: 30 });
            const packagesInstalled = await installRequirements();
            if (!packagesInstalled) {
                throw new Error('패키지 설치 실패');
            }
            
            // 테스트
            progress.report({ message: "설치 확인 중...", increment: 90 });
            const testPassed = await testVirtualEnvironment();
            if (!testPassed) {
                throw new Error('패키지 테스트 실패');
            }
            
            // 완료 마커 생성
            progress.report({ message: "설정 완료 중...", increment: 100 });
            createVenvMarker();
            
            logSuccess('🎉 LipCoder 가상환경 설정이 완료되었습니다!');
            
            vscode.window.showInformationMessage(
                '🎉 LipCoder 가상환경 설정 완료!\\n\\n' +
                '✅ Python 가상환경 생성\\n' +
                '✅ 모든 필수 패키지 설치\\n' +
                '✅ 설치 확인 테스트 통과\\n\\n' +
                '이제 LipCoder의 모든 기능을 사용할 수 있습니다.'
            );
            
            return true;
            
        } catch (error) {
            logError(`❌ 가상환경 설정 중 오류 발생: ${error}`);
            
            vscode.window.showErrorMessage(
                `❌ 가상환경 설정 실패: ${error}\\n\\n` +
                '자세한 내용은 LipCoder 출력 패널을 확인해주세요.',
                '출력 패널 열기'
            ).then(selection => {
                if (selection === '출력 패널 열기') {
                    vscode.commands.executeCommand('workbench.action.output.toggleOutput');
                }
            });
            
            return false;
        }
    });
}

/**
 * 가상환경 상태 확인
 */
export function getVenvStatus(): { exists: boolean; ready: boolean; path: string } {
    return {
        exists: checkVenvExists(),
        ready: checkVenvReady(),
        path: VENV_PATH
    };
}

/**
 * 가상환경 Python 경로 반환
 */
export function getVenvPython(): string {
    return VENV_PYTHON;
}

/**
 * VS Code 명령어 등록
 */
export function registerVenvCommands(context: vscode.ExtensionContext): void {
    // 가상환경 설정 명령어
    const setupCommand = vscode.commands.registerCommand(
        'lipcoder.setupVenv',
        async () => {
            await setupVirtualEnvironment();
        }
    );
    
    // 가상환경 상태 확인 명령어
    const statusCommand = vscode.commands.registerCommand(
        'lipcoder.checkVenvStatus',
        () => {
            const status = getVenvStatus();
            const message = status.ready 
                ? '✅ LipCoder 가상환경이 정상적으로 설정되어 있습니다.'
                : '⚠️ LipCoder 가상환경이 설정되지 않았습니다.';
            
            vscode.window.showInformationMessage(
                `${message}\\n\\n` +
                `경로: ${status.path}\\n` +
                `존재: ${status.exists ? '✅' : '❌'}\\n` +
                `준비: ${status.ready ? '✅' : '❌'}`
            );
        }
    );
    
    // 가상환경 재설정 명령어
    const resetCommand = vscode.commands.registerCommand(
        'lipcoder.resetVenv',
        async () => {
            const confirm = await vscode.window.showWarningMessage(
                '⚠️ LipCoder 가상환경을 완전히 제거하고 다시 설정하시겠습니까?',
                { modal: true },
                '✅ 재설정',
                '❌ 취소'
            );
            
            if (confirm === '✅ 재설정') {
                if (fs.existsSync(VENV_PATH)) {
                    fs.rmSync(VENV_PATH, { recursive: true, force: true });
                    log('🗑️ 기존 가상환경 제거 완료');
                }
                await setupVirtualEnvironment();
            }
        }
    );
    
    context.subscriptions.push(setupCommand, statusCommand, resetCommand);
    log('✅ 가상환경 관리 명령어가 등록되었습니다');
}
