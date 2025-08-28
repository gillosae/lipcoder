import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { log, logError, logSuccess, logWarning } from '../utils';

/**
 * 🔧 DependencyInstaller - 개별 도구 관리 및 문제 해결 시스템
 * 
 * 역할:
 * - 개별 의존성 체크, 설치, 문제 진단
 * - 고급 사용자를 위한 세밀한 제어
 * - Native 모듈 개별 빌드 및 관리
 * - 문제 해결 및 복구 기능
 * 
 * vs first_time_setup.ts:
 * - dependency_installer: 개별 도구 관리, 문제 해결, 고급 사용자용
 * - first_time_setup: 신규 사용자 자동 설정, 통합 환경 구축
 * 
 * Node.js, Python, Homebrew 등의 필수 도구들을 개별적으로 관리합니다.
 */

interface DependencyInfo {
    name: string;
    friendlyName: string;
    checkCommand: string[];
    installCommand: string[];
    downloadUrl?: string;
    isRequired: boolean;
    description: string;
}

// macOS 의존성 정의
const MACOS_DEPENDENCIES: DependencyInfo[] = [
    {
        name: 'node',
        friendlyName: 'Node.js',
        checkCommand: ['node', '--version'],
        installCommand: ['brew', 'install', 'node'],
        downloadUrl: 'https://nodejs.org/ko/download/',
        isRequired: true,
        description: 'JavaScript 런타임 - LipCoder의 핵심 기능에 필요합니다'
    },
    {
        name: 'npm',
        friendlyName: 'npm',
        checkCommand: ['npm', '--version'],
        installCommand: ['brew', 'install', 'node'], // npm은 node와 함께 설치됨
        downloadUrl: 'https://nodejs.org/ko/download/',
        isRequired: true,
        description: 'Node.js 패키지 매니저 - 확장 기능 빌드에 필요합니다'
    },
    {
        name: 'python3',
        friendlyName: 'Python 3',
        checkCommand: ['python3', '--version'],
        installCommand: ['brew', 'install', 'python@3.11'],
        downloadUrl: 'https://www.python.org/downloads/',
        isRequired: true,
        description: 'Python 런타임 - TTS 및 ASR 기능에 필요합니다'
    },
    {
        name: 'brew',
        friendlyName: 'Homebrew',
        checkCommand: ['brew', '--version'],
        installCommand: [], // Homebrew는 특별한 설치 방법이 필요
        downloadUrl: 'https://brew.sh/index_ko',
        isRequired: false,
        description: '패키지 매니저 - 다른 도구들의 자동 설치에 필요합니다'
    },
    {
        name: 'ffmpeg',
        friendlyName: 'FFmpeg',
        checkCommand: ['ffmpeg', '-version'],
        installCommand: ['brew', 'install', 'ffmpeg'],
        downloadUrl: 'https://ffmpeg.org/download.html',
        isRequired: false,
        description: '오디오 처리 도구 - 고급 오디오 기능에 필요합니다'
    }
];

// Node.js 네이티브 모듈 의존성 정의
const NODE_NATIVE_DEPENDENCIES: DependencyInfo[] = [
    {
        name: 'node-pty',
        friendlyName: 'node-pty (터미널 모듈)',
        checkCommand: ['node', '-e', 'require("node-pty"); console.log("installed")'],
        installCommand: ['npm', 'rebuild', 'node-pty'],
        downloadUrl: 'https://github.com/microsoft/node-pty',
        isRequired: false,
        description: '터미널 기능 - LipCoder 터미널 고급 기능에 필요합니다 (fallback 있음)'
    },
    {
        name: 'speaker',
        friendlyName: 'Speaker (오디오 출력 모듈)',
        checkCommand: ['node', '-e', 'require("speaker"); console.log("installed")'],
        installCommand: ['npm', 'rebuild', 'speaker'],
        downloadUrl: 'https://github.com/TooTallNate/node-speaker',
        isRequired: false,
        description: '오디오 출력 모듈 - 직접 오디오 재생에 필요합니다'
    }
];

// Python 패키지 의존성 정의
const PYTHON_DEPENDENCIES: DependencyInfo[] = [
    {
        name: 'flask',
        friendlyName: 'Flask',
        checkCommand: ['python3', '-c', 'import flask; print(flask.__version__)'],
        installCommand: ['pip3', 'install', 'flask>=2.3.0'],
        downloadUrl: 'https://flask.palletsprojects.com/',
        isRequired: true,
        description: 'Python 웹 프레임워크 - TTS/ASR 서버에 필요합니다'
    },
    {
        name: 'uvicorn',
        friendlyName: 'Uvicorn (ASGI 서버)',
        checkCommand: ['python3', '-c', 'import uvicorn; print(uvicorn.__version__)'],
        installCommand: ['pip3', 'install', 'uvicorn>=0.23.0'],
        downloadUrl: 'https://www.uvicorn.org/',
        isRequired: true,
        description: 'ASGI 웹 서버 - 고성능 Python 서버 실행에 필요합니다'
    },
    {
        name: 'asgiref',
        friendlyName: 'ASGIREF (ASGI 유틸리티)',
        checkCommand: ['python3', '-c', 'import asgiref; print(asgiref.__version__)'],
        installCommand: ['pip3', 'install', 'asgiref>=3.7.0'],
        downloadUrl: 'https://github.com/django/asgiref',
        isRequired: true,
        description: 'ASGI 레퍼런스 구현 - WSGI to ASGI 변환에 필요합니다'
    },
    {
        name: 'torch',
        friendlyName: 'PyTorch',
        checkCommand: ['python3', '-c', 'import torch; print(torch.__version__)'],
        installCommand: ['pip3', 'install', 'torch>=2.0.0', 'torchaudio>=2.0.0'],
        downloadUrl: 'https://pytorch.org/get-started/locally/',
        isRequired: true,
        description: 'PyTorch 딥러닝 프레임워크 - AI 모델 실행에 필요합니다'
    },
    {
        name: 'TTS',
        friendlyName: 'Coqui TTS',
        checkCommand: ['python3', '-c', 'import TTS; print(TTS.__version__)'],
        installCommand: ['pip3', 'install', 'TTS>=0.22.0'],
        downloadUrl: 'https://github.com/coqui-ai/TTS',
        isRequired: false,
        description: 'Coqui TTS 라이브러리 - XTTS-v2 음성 합성에 필요합니다'
    },
    {
        name: 'soundfile',
        friendlyName: 'SoundFile',
        checkCommand: ['python3', '-c', 'import soundfile; print(soundfile.__version__)'],
        installCommand: ['pip3', 'install', 'soundfile>=0.12.1'],
        downloadUrl: 'https://github.com/bastibe/python-soundfile',
        isRequired: true,
        description: '오디오 파일 처리 라이브러리 - 음성 파일 읽기/쓰기에 필요합니다'
    },
    {
        name: 'numpy',
        friendlyName: 'NumPy',
        checkCommand: ['python3', '-c', 'import numpy; print(numpy.__version__)'],
        installCommand: ['pip3', 'install', 'numpy==1.22.0'],
        downloadUrl: 'https://numpy.org/',
        isRequired: true,
        description: '수치 계산 라이브러리 - 오디오 데이터 처리에 필요합니다'
    },
    {
        name: 'flask_cors',
        friendlyName: 'Flask-CORS',
        checkCommand: ['python3', '-c', 'import flask_cors; print("installed")'],
        installCommand: ['pip3', 'install', 'flask-cors'],
        downloadUrl: 'https://flask-cors.readthedocs.io/',
        isRequired: true,
        description: 'Flask CORS 지원 - 브라우저에서 서버 접근에 필요합니다'
    }
];

/**
 * 명령어 실행 가능 여부 체크
 */
async function checkCommandAvailable(command: string[]): Promise<boolean> {
    return new Promise((resolve) => {
        const process = cp.spawn(command[0], command.slice(1), { 
            stdio: 'ignore',
            timeout: 5000 
        });
        
        process.on('error', () => resolve(false));
        process.on('exit', (code) => resolve(code === 0));
        process.on('timeout', () => {
            process.kill();
            resolve(false);
        });
    });
}

/**
 * Node.js 버전 변경 감지 및 자동 재빌드
 */
async function checkAndRebuildIfNeeded(): Promise<void> {
    try {
        const currentNodeVersion = process.version;
        const versionFile = path.join(__dirname, '..', '..', '..', '.node-version-cache');
        
        let lastNodeVersion = '';
        try {
            lastNodeVersion = fs.readFileSync(versionFile, 'utf8').trim();
        } catch (error) {
            // 파일이 없으면 첫 실행
            log('🔧 첫 실행 또는 버전 캐시 파일 없음');
        }
        
        if (currentNodeVersion !== lastNodeVersion) {
            log(`🔄 Node.js 버전 변경 감지: ${lastNodeVersion} → ${currentNodeVersion}`);
            log('🔧 네이티브 모듈 자동 재빌드를 시작합니다...');
            
            // 네이티브 모듈 재빌드
            const rebuildSuccess = await rebuildAllNativeModules();
            
            if (rebuildSuccess) {
                // 성공하면 버전 캐시 업데이트
                fs.writeFileSync(versionFile, currentNodeVersion);
                logSuccess('✅ 네이티브 모듈 재빌드 완료 및 버전 캐시 업데이트');
            } else {
                logWarning('⚠️ 네이티브 모듈 재빌드 실패, 하지만 fallback으로 동작합니다');
            }
        }
    } catch (error) {
        logError(`❌ Node.js 버전 체크 중 오류: ${error}`);
    }
}

/**
 * 모든 네이티브 모듈 재빌드
 */
async function rebuildAllNativeModules(): Promise<boolean> {
    try {
        log('🔧 npm rebuild 실행 중...');
        
        return new Promise((resolve) => {
            const rebuildProcess = cp.spawn('npm', ['rebuild'], {
                stdio: ['ignore', 'pipe', 'pipe'],
                timeout: 60000 // 1분 타임아웃
            });
            
            let output = '';
            let errorOutput = '';
            
            rebuildProcess.stdout?.on('data', (data) => {
                output += data.toString();
            });
            
            rebuildProcess.stderr?.on('data', (data) => {
                errorOutput += data.toString();
            });
            
            rebuildProcess.on('exit', (code) => {
                if (code === 0) {
                    logSuccess('✅ npm rebuild 성공');
                    resolve(true);
                } else {
                    logError(`❌ npm rebuild 실패 (exit code: ${code})`);
                    if (errorOutput) logError(`   stderr: ${errorOutput.trim()}`);
                    resolve(false);
                }
            });
            
            rebuildProcess.on('error', (error) => {
                logError(`❌ npm rebuild 프로세스 오류: ${error.message}`);
                resolve(false);
            });
            
            rebuildProcess.on('timeout', () => {
                logWarning('⏰ npm rebuild 타임아웃');
                rebuildProcess.kill();
                resolve(false);
            });
        });
    } catch (error) {
        logError(`❌ 네이티브 모듈 재빌드 중 오류: ${error}`);
        return false;
    }
}

/**
 * Homebrew 설치 스크립트 실행
 */
async function installHomebrew(): Promise<boolean> {
    return new Promise((resolve) => {
        const installScript = '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"';
        
        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Homebrew 설치 중...",
            cancellable: false
        }, async (progress) => {
            progress.report({ message: "설치 스크립트를 다운로드하고 실행하고 있습니다..." });
            
            const process = cp.exec(installScript, { timeout: 300000 }); // 5분 타임아웃
            
            process.on('exit', (code) => {
                if (code === 0) {
                    logSuccess('✅ Homebrew가 성공적으로 설치되었습니다');
                    resolve(true);
                } else {
                    logError(`❌ Homebrew 설치 실패 (exit code: ${code})`);
                    resolve(false);
                }
            });
            
            process.on('error', (error) => {
                logError(`❌ Homebrew 설치 중 오류 발생: ${error.message}`);
                resolve(false);
            });
        });
    });
}

/**
 * 패키지 설치 실행
 */
async function installPackage(dependency: DependencyInfo): Promise<boolean> {
    if (dependency.name === 'brew') {
        return await installHomebrew();
    }
    
    if (dependency.installCommand.length === 0) {
        return false;
    }
    
    return new Promise((resolve) => {
        const [command, ...args] = dependency.installCommand;
        
        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `${dependency.friendlyName} 설치 중...`,
            cancellable: false
        }, async (progress) => {
            progress.report({ message: `${dependency.friendlyName}을(를) 설치하고 있습니다...` });
            
            const process = cp.spawn(command, args, { 
                stdio: 'pipe',
                timeout: 300000 // 5분 타임아웃
            });
            
            let output = '';
            process.stdout?.on('data', (data) => {
                output += data.toString();
            });
            
            process.stderr?.on('data', (data) => {
                output += data.toString();
            });
            
            process.on('exit', (code) => {
                if (code === 0) {
                    logSuccess(`✅ ${dependency.friendlyName}이(가) 성공적으로 설치되었습니다`);
                    resolve(true);
                } else {
                    logError(`❌ ${dependency.friendlyName} 설치 실패 (exit code: ${code})`);
                    logError(`설치 로그: ${output}`);
                    resolve(false);
                }
            });
            
            process.on('error', (error) => {
                logError(`❌ ${dependency.friendlyName} 설치 중 오류 발생: ${error.message}`);
                resolve(false);
            });
        });
    });
}

/**
 * 사용자에게 설치 확인 요청
 */
async function askUserForInstallation(dependency: DependencyInfo): Promise<'install' | 'manual' | 'skip'> {
    const message = `🚨 ${dependency.friendlyName}이(가) 설치되어 있지 않습니다.\n\n` +
                   `${dependency.description}\n\n` +
                   `자동으로 설치하시겠습니까?`;
    
    const choice = await vscode.window.showWarningMessage(
        message,
        { modal: true },
        '🔧 자동 설치',
        '📖 수동 설치 가이드',
        '⏭️ 건너뛰기'
    );
    
    switch (choice) {
        case '🔧 자동 설치':
            return 'install';
        case '📖 수동 설치 가이드':
            return 'manual';
        default:
            return 'skip';
    }
}

/**
 * 수동 설치 가이드 표시
 */
async function showManualInstallGuide(dependency: DependencyInfo) {
    const platform = os.platform();
    let installInstructions = '';
    
    if (platform === 'darwin') {
        if (dependency.name === 'brew') {
            installInstructions = `터미널에서 다음 명령어를 실행하세요:\n\n` +
                                `/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"`;
        } else if (dependency.installCommand.length > 0) {
            installInstructions = `터미널에서 다음 명령어를 실행하세요:\n\n` +
                                `${dependency.installCommand.join(' ')}`;
        }
    }
    
    if (dependency.downloadUrl) {
        installInstructions += `\n\n또는 공식 웹사이트에서 다운로드:\n${dependency.downloadUrl}`;
    }
    
    const message = `📖 ${dependency.friendlyName} 수동 설치 가이드\n\n${installInstructions}`;
    
    const choice = await vscode.window.showInformationMessage(
        message,
        { modal: true },
        '🌐 웹사이트 열기',
        '✅ 확인'
    );
    
    if (choice === '🌐 웹사이트 열기' && dependency.downloadUrl) {
        vscode.env.openExternal(vscode.Uri.parse(dependency.downloadUrl));
    }
}

/**
 * 단일 의존성 체크 및 설치
 */
async function checkAndInstallDependency(dependency: DependencyInfo): Promise<boolean> {
    log(`🔍 ${dependency.friendlyName} 확인 중...`);
    
    const isAvailable = await checkCommandAvailable(dependency.checkCommand);
    
    if (isAvailable) {
        logSuccess(`✅ ${dependency.friendlyName} 설치됨`);
        return true;
    }
    
    logWarning(`⚠️ ${dependency.friendlyName} 미설치`);
    
    if (!dependency.isRequired) {
        log(`ℹ️ ${dependency.friendlyName}은(는) 선택사항입니다. 건너뜁니다.`);
        return false;
    }
    
    const userChoice = await askUserForInstallation(dependency);
    
    switch (userChoice) {
        case 'install':
            const success = await installPackage(dependency);
            if (success) {
                // 설치 후 다시 확인
                const recheckResult = await checkCommandAvailable(dependency.checkCommand);
                if (recheckResult) {
                    vscode.window.showInformationMessage(
                        `🎉 ${dependency.friendlyName}이(가) 성공적으로 설치되었습니다!`
                    );
                    return true;
                } else {
                    vscode.window.showErrorMessage(
                        `❌ ${dependency.friendlyName} 설치는 완료되었지만 명령어를 찾을 수 없습니다. 터미널을 재시작해보세요.`
                    );
                    return false;
                }
            } else {
                vscode.window.showErrorMessage(
                    `❌ ${dependency.friendlyName} 자동 설치에 실패했습니다. 수동 설치를 시도해보세요.`
                );
                return false;
            }
            
        case 'manual':
            await showManualInstallGuide(dependency);
            return false;
            
        case 'skip':
            logWarning(`⏭️ ${dependency.friendlyName} 설치를 건너뛰었습니다`);
            return false;
            
        default:
            return false;
    }
}

/**
 * Node.js 네이티브 모듈 체크
 */
async function checkNodeNativeDependencies(): Promise<boolean> {
    log('🔧 Node.js 네이티브 모듈을 체크합니다...');
    
    const missingModules: DependencyInfo[] = [];
    
    // 모든 네이티브 모듈 체크
    for (const dependency of NODE_NATIVE_DEPENDENCIES) {
        const isAvailable = await checkCommandAvailable(dependency.checkCommand);
        if (!isAvailable) {
            missingModules.push(dependency);
            logWarning(`⚠️ ${dependency.friendlyName} 미설치 또는 빌드 필요`);
        } else {
            logSuccess(`✅ ${dependency.friendlyName} 설치됨`);
        }
    }
    
    if (missingModules.length === 0) {
        logSuccess('✅ 모든 Node.js 네이티브 모듈이 설치되어 있습니다');
        return true;
    }
    
    // 누락된 모듈들 표시
    const missingList = missingModules.map(mod => `• ${mod.friendlyName}`).join('\n');
    
    const message = `🔧 다음 Node.js 네이티브 모듈들이 설치되지 않았거나 재빌드가 필요합니다:\n\n${missingList}\n\n` +
                   `이 모듈들은 선택사항이며, 없어도 LipCoder는 fallback 기능으로 동작합니다.\n` +
                   `하지만 설치하면 더 나은 성능을 제공합니다.`;
    
    const choice = await vscode.window.showInformationMessage(
        message,
        { modal: false }, // 네이티브 모듈은 필수가 아니므로 modal=false
        '🔧 자동 재빌드',
        '📖 수동 설치 가이드',
        '⏭️ 건너뛰기'
    );
    
    switch (choice) {
        case '🔧 자동 재빌드':
            return await rebuildNativeModules(missingModules);
            
        case '📖 수동 설치 가이드':
            await showNativeModuleGuide(missingModules);
            return false;
            
        default:
            log('ℹ️ 네이티브 모듈 설치를 건너뛰었습니다. LipCoder는 fallback 기능으로 동작합니다.');
            return true; // 네이티브 모듈은 선택사항이므로 true 반환
    }
}

/**
 * 네이티브 모듈 재빌드
 */
async function rebuildNativeModules(modules: DependencyInfo[]): Promise<boolean> {
    let successCount = 0;
    
    vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Node.js 네이티브 모듈 재빌드 중...",
        cancellable: false
    }, async (progress) => {
        for (let i = 0; i < modules.length; i++) {
            const mod = modules[i];
            progress.report({ 
                message: `${mod.friendlyName} 재빌드 중... (${i + 1}/${modules.length})`,
                increment: (100 / modules.length)
            });
            
            const success = await installPackage(mod);
            if (success) {
                successCount++;
            }
        }
    });
    
    const message = `🔧 네이티브 모듈 재빌드 완료: ${successCount}/${modules.length}개 성공`;
    
    if (successCount === modules.length) {
        vscode.window.showInformationMessage(`🎉 ${message}`);
        return true;
    } else if (successCount > 0) {
        vscode.window.showWarningMessage(`⚠️ ${message} - 일부 모듈은 fallback으로 동작합니다`);
        return true; // 부분 성공도 OK (fallback 있음)
    } else {
        vscode.window.showWarningMessage(`⚠️ ${message} - fallback 기능으로 동작합니다`);
        return true; // 실패해도 OK (fallback 있음)
    }
}

/**
 * 네이티브 모듈 수동 설치 가이드
 */
async function showNativeModuleGuide(modules: DependencyInfo[]): Promise<void> {
    const moduleList = modules.map(mod => 
        `• ${mod.friendlyName}: ${mod.installCommand.join(' ')}`
    ).join('\n');
    
    const message = `📖 Node.js 네이티브 모듈 수동 설치 가이드\n\n` +
                   `터미널에서 다음 명령어들을 실행하세요:\n\n${moduleList}\n\n` +
                   `또는 전체 재빌드:\n` +
                   `npm rebuild\n\n` +
                   `⚠️ 참고: 이 모듈들이 없어도 LipCoder는 정상 동작합니다.\n` +
                   `네이티브 모듈은 성능 향상을 위한 선택사항입니다.`;
    
    const choice = await vscode.window.showInformationMessage(
        message,
        { modal: true },
        '📋 클립보드에 복사',
        '✅ 확인'
    );
    
    if (choice === '📋 클립보드에 복사') {
        const commands = modules.map(mod => mod.installCommand.join(' ')).join('\n');
        vscode.env.clipboard.writeText(commands);
        vscode.window.showInformationMessage('📋 재빌드 명령어가 클립보드에 복사되었습니다!');
    }
}

/**
 * Python 패키지 체크 (일괄 설치 옵션 포함)
 */
async function checkPythonDependencies(): Promise<boolean> {
    log('🐍 Python 패키지 의존성을 체크합니다...');
    
    const missingPackages: DependencyInfo[] = [];
    
    // 모든 Python 패키지 체크
    for (const dependency of PYTHON_DEPENDENCIES) {
        const isAvailable = await checkCommandAvailable(dependency.checkCommand);
        if (!isAvailable) {
            missingPackages.push(dependency);
            logWarning(`⚠️ ${dependency.friendlyName} 미설치`);
        } else {
            logSuccess(`✅ ${dependency.friendlyName} 설치됨`);
        }
    }
    
    if (missingPackages.length === 0) {
        logSuccess('✅ 모든 Python 패키지가 설치되어 있습니다');
        return true;
    }
    
    // 누락된 패키지들 표시
    const missingList = missingPackages.map(pkg => `• ${pkg.friendlyName}`).join('\n');
    const requiredMissing = missingPackages.filter(pkg => pkg.isRequired);
    
    const message = `🐍 다음 Python 패키지들이 설치되어 있지 않습니다:\n\n${missingList}\n\n` +
                   `이 패키지들은 LipCoder의 TTS/ASR 서버 기능에 필요합니다.`;
    
    const choice = await vscode.window.showWarningMessage(
        message,
        { modal: true },
        '🔧 모든 패키지 자동 설치',
        '📦 requirements.txt로 설치',
        '📖 수동 설치 가이드',
        '⏭️ 건너뛰기'
    );
    
    switch (choice) {
        case '🔧 모든 패키지 자동 설치':
            return await installAllPythonPackages(missingPackages);
            
        case '📦 requirements.txt로 설치':
            return await installFromRequirements();
            
        case '📖 수동 설치 가이드':
            await showPythonInstallGuide(missingPackages);
            return false;
            
        default:
            return requiredMissing.length === 0;
    }
}

/**
 * 모든 Python 패키지 자동 설치
 */
async function installAllPythonPackages(packages: DependencyInfo[]): Promise<boolean> {
    let successCount = 0;
    
    for (const pkg of packages) {
        const success = await installPackage(pkg);
        if (success) {
            successCount++;
        }
    }
    
    const message = `📦 Python 패키지 설치 완료: ${successCount}/${packages.length}개 성공`;
    
    if (successCount === packages.length) {
        vscode.window.showInformationMessage(`🎉 ${message}`);
        return true;
    } else {
        vscode.window.showWarningMessage(`⚠️ ${message}`);
        return false;
    }
}

/**
 * requirements.txt를 사용한 설치
 */
async function installFromRequirements(): Promise<boolean> {
    return new Promise((resolve) => {
        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "requirements.txt로 Python 패키지 설치 중...",
            cancellable: false
        }, async (progress) => {
            progress.report({ message: "pip install -r requirements_xtts.txt 실행 중..." });
            
            // 프로젝트 루트에서 requirements 파일 찾기
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                vscode.window.showErrorMessage('워크스페이스 폴더를 찾을 수 없습니다.');
                resolve(false);
                return;
            }
            
            const requirementsPath = path.join(workspaceFolder.uri.fsPath, 'server', 'requirements_xtts.txt');
            
            const install = cp.spawn('pip3', ['install', '-r', requirementsPath], { 
                stdio: 'pipe',
                timeout: 600000 // 10분 타임아웃
            });
            
            let output = '';
            install.stdout?.on('data', (data) => {
                output += data.toString();
            });
            
            install.stderr?.on('data', (data) => {
                output += data.toString();
            });
            
            install.on('exit', (code) => {
                if (code === 0) {
                    vscode.window.showInformationMessage(
                        '🎉 requirements.txt로 Python 패키지가 성공적으로 설치되었습니다!'
                    );
                    logSuccess('✅ requirements.txt 설치 완료');
                    resolve(true);
                } else {
                    vscode.window.showErrorMessage(
                        '❌ requirements.txt 설치에 실패했습니다. 로그를 확인해주세요.'
                    );
                    logError(`❌ requirements.txt 설치 실패: ${output}`);
                    resolve(false);
                }
            });
            
            install.on('error', (error) => {
                vscode.window.showErrorMessage(
                    `❌ requirements.txt 설치 중 오류: ${error.message}`
                );
                logError(`❌ requirements.txt 설치 오류: ${error.message}`);
                resolve(false);
            });
        });
    });
}

/**
 * Python 패키지 수동 설치 가이드
 */
async function showPythonInstallGuide(packages: DependencyInfo[]): Promise<void> {
    const packageList = packages.map(pkg => 
        `• ${pkg.friendlyName}: ${pkg.installCommand.join(' ')}`
    ).join('\n');
    
    const message = `📖 Python 패키지 수동 설치 가이드\n\n` +
                   `터미널에서 다음 명령어들을 실행하세요:\n\n${packageList}\n\n` +
                   `또는 한 번에 설치:\n` +
                   `pip3 install -r server/requirements_xtts.txt`;
    
    const choice = await vscode.window.showInformationMessage(
        message,
        { modal: true },
        '📋 클립보드에 복사',
        '✅ 확인'
    );
    
    if (choice === '📋 클립보드에 복사') {
        const commands = packages.map(pkg => pkg.installCommand.join(' ')).join('\n');
        vscode.env.clipboard.writeText(commands);
        vscode.window.showInformationMessage('📋 설치 명령어가 클립보드에 복사되었습니다!');
    }
}

/**
 * 모든 의존성 체크 및 설치
 */
export async function checkAndInstallAllDependencies(): Promise<void> {
    const platform = os.platform();
    
    if (platform !== 'darwin') {
        vscode.window.showWarningMessage(
            '🍎 LipCoder는 현재 macOS에서만 완전히 지원됩니다. 다른 플랫폼에서는 일부 기능이 제한될 수 있습니다.'
        );
        return;
    }
    
    log('🔧 시스템 의존성 체크를 시작합니다...');
    
    // Node.js 버전 변경 감지 및 자동 재빌드
    await checkAndRebuildIfNeeded();
    
    const results: { [key: string]: boolean } = {};
    let hasFailures = false;
    
    // 1. macOS 시스템 의존성 체크
    log('📱 macOS 시스템 도구 체크 중...');
    for (const dependency of MACOS_DEPENDENCIES) {
        try {
            const result = await checkAndInstallDependency(dependency);
            results[dependency.name] = result;
            
            if (dependency.isRequired && !result) {
                hasFailures = true;
            }
        } catch (error) {
            logError(`❌ ${dependency.friendlyName} 체크 중 오류: ${error}`);
            results[dependency.name] = false;
            if (dependency.isRequired) {
                hasFailures = true;
            }
        }
    }
    
    // 2. Node.js 네이티브 모듈 체크
    try {
        const nativeResult = await checkNodeNativeDependencies();
        results['native_modules'] = nativeResult;
        // 네이티브 모듈은 선택사항이므로 실패해도 hasFailures에 영향 없음
    } catch (error) {
        logError(`❌ Node.js 네이티브 모듈 체크 중 오류: ${error}`);
        results['native_modules'] = false;
        // 네이티브 모듈 실패는 전체 실패로 간주하지 않음
    }
    
    // 3. Python 패키지 의존성 체크
    try {
        const pythonResult = await checkPythonDependencies();
        results['python_packages'] = pythonResult;
        
        if (!pythonResult) {
            hasFailures = true;
        }
    } catch (error) {
        logError(`❌ Python 패키지 체크 중 오류: ${error}`);
        results['python_packages'] = false;
        hasFailures = true;
    }
    
    // 결과 요약
    const systemCount = Object.entries(results)
        .filter(([key, value]) => !['python_packages', 'native_modules'].includes(key) && value).length;
    const systemTotal = MACOS_DEPENDENCIES.length;
    const pythonStatus = results['python_packages'] ? '✅' : '❌';
    const nativeStatus = results['native_modules'] ? '✅' : '⚠️';
    
    log(`📊 의존성 체크 완료:`);
    log(`   • 시스템 도구: ${systemCount}/${systemTotal} 설치됨`);
    log(`   • Python 패키지: ${pythonStatus}`);
    log(`   • 네이티브 모듈: ${nativeStatus} ${results['native_modules'] ? '' : '(fallback 사용)'}`);
    
    if (hasFailures) {
        const message = '⚠️ 일부 필수 의존성이 설치되지 않았습니다. LipCoder의 일부 기능이 제한될 수 있습니다.\n\n' +
                       '나중에 "LipCoder: Check Dependencies" 명령어로 다시 확인할 수 있습니다.';
        
        vscode.window.showWarningMessage(message, '확인');
    } else {
        const message = '🎉 모든 의존성이 성공적으로 설치되었습니다! LipCoder를 완전히 사용할 수 있습니다.';
        vscode.window.showInformationMessage(message);
    }
}

/**
 * 특정 의존성만 체크
 */
export async function checkSpecificDependency(dependencyName: string): Promise<boolean> {
    const dependency = MACOS_DEPENDENCIES.find(dep => dep.name === dependencyName);
    
    if (!dependency) {
        logError(`❌ 알 수 없는 의존성: ${dependencyName}`);
        return false;
    }
    
    return await checkAndInstallDependency(dependency);
}

/**
 * 의존성 상태 확인 (설치 없이)
 */
export async function getDependencyStatus(): Promise<{ [key: string]: boolean }> {
    const status: { [key: string]: boolean } = {};
    
    // 시스템 도구 체크
    for (const dependency of MACOS_DEPENDENCIES) {
        try {
            status[dependency.name] = await checkCommandAvailable(dependency.checkCommand);
        } catch (error) {
            status[dependency.name] = false;
        }
    }
    
    // 네이티브 모듈 체크
    for (const dependency of NODE_NATIVE_DEPENDENCIES) {
        try {
            status[dependency.name] = await checkCommandAvailable(dependency.checkCommand);
        } catch (error) {
            status[dependency.name] = false;
        }
    }
    
    // Python 패키지 체크
    for (const dependency of PYTHON_DEPENDENCIES) {
        try {
            status[dependency.name] = await checkCommandAvailable(dependency.checkCommand);
        } catch (error) {
            status[dependency.name] = false;
        }
    }
    
    return status;
}

/**
 * VS Code 명령어 등록
 */
export function registerDependencyCommands(context: vscode.ExtensionContext) {
    // 의존성 체크 명령어
    const checkDepsCommand = vscode.commands.registerCommand(
        'lipcoder.checkDependencies',
        async () => {
            await checkAndInstallAllDependencies();
        }
    );
    
    // 의존성 상태 표시 명령어
    const showStatusCommand = vscode.commands.registerCommand(
        'lipcoder.showDependencyStatus',
        async () => {
            const status = await getDependencyStatus();
            
            let message = '📋 LipCoder 의존성 상태:\n\n';
            
            // 시스템 도구
            message += '🖥️ 시스템 도구:\n';
            for (const dependency of MACOS_DEPENDENCIES) {
                const isInstalled = status[dependency.name];
                const icon = isInstalled ? '✅' : '❌';
                const requiredText = dependency.isRequired ? ' (필수)' : ' (선택)';
                message += `  ${icon} ${dependency.friendlyName}${requiredText}\n`;
            }
            
            // 네이티브 모듈
            message += '\n🔧 Node.js 네이티브 모듈:\n';
            for (const dependency of NODE_NATIVE_DEPENDENCIES) {
                const isInstalled = status[dependency.name];
                const icon = isInstalled ? '✅' : '⚠️';
                message += `  ${icon} ${dependency.friendlyName} (선택, fallback 있음)\n`;
            }
            
            // Python 패키지
            message += '\n🐍 Python 패키지:\n';
            for (const dependency of PYTHON_DEPENDENCIES) {
                const isInstalled = status[dependency.name];
                const icon = isInstalled ? '✅' : '❌';
                const requiredText = dependency.isRequired ? ' (필수)' : ' (선택)';
                message += `  ${icon} ${dependency.friendlyName}${requiredText}\n`;
            }
            
            vscode.window.showInformationMessage(message, { modal: true }, '확인');
        }
    );
    
    // Node.js 전용 체크 명령어
    const checkNodeCommand = vscode.commands.registerCommand(
        'lipcoder.checkNodeJS',
        async () => {
            const nodeInstalled = await checkSpecificDependency('node');
            const npmInstalled = await checkSpecificDependency('npm');
            
            if (nodeInstalled && npmInstalled) {
                vscode.window.showInformationMessage('🎉 Node.js와 npm이 모두 설치되어 있습니다!');
            } else {
                vscode.window.showWarningMessage('⚠️ Node.js 또는 npm이 설치되어 있지 않습니다.');
            }
        }
    );
    
    // 네이티브 모듈 전용 체크 명령어
    const checkNativeCommand = vscode.commands.registerCommand(
        'lipcoder.checkNativeModules',
        async () => {
            const result = await checkNodeNativeDependencies();
            
            if (result) {
                vscode.window.showInformationMessage('🎉 모든 네이티브 모듈이 정상적으로 설치되어 있습니다!');
            } else {
                vscode.window.showWarningMessage('⚠️ 일부 네이티브 모듈이 설치되지 않았지만, fallback 기능으로 동작합니다.');
            }
        }
    );
    
    context.subscriptions.push(checkDepsCommand, showStatusCommand, checkNodeCommand, checkNativeCommand);
    
    log('✅ 의존성 관리 명령어가 등록되었습니다');
}
