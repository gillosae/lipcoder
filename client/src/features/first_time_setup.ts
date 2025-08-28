import * as vscode from 'vscode';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { logError, logSuccess, logWarning } from '../utils';
import { checkAndInstallAllDependencies, getDependencyStatus } from './dependency_installer';

const execAsync = promisify(exec);

/**
 * 🚀 FirstTimeSetup - 신규 사용자를 위한 자동 환경 구축 시스템
 * 
 * 역할:
 * - Extension 첫 실행 시 자동으로 완전한 환경 구축
 * - 사용자 친화적인 UI와 진행률 표시
 * - 가상환경 생성 + 정확한 버전 설치 + Electron 타겟 빌드
 * - 원클릭 완전 자동 설정
 * 
 * vs dependency_installer.ts:
 * - dependency_installer: 개별 도구 관리, 문제 해결, 고급 사용자용
 * - first_time_setup: 신규 사용자 자동 설정, 통합 환경 구축
 */

interface SetupProgress {
    step: string;
    progress: number;
    total: number;
    status: 'pending' | 'running' | 'completed' | 'failed';
}

export class FirstTimeSetup {
    private context: vscode.ExtensionContext;
    private isSetupComplete: boolean = false;
    
    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.isSetupComplete = this.context.globalState.get('lipcoder.setupComplete', false);
    }

    /**
     * Extension 첫 실행 시 자동 설정 확인 및 실행
     */
    async checkAndRunFirstTimeSetup(): Promise<boolean> {
        if (this.isSetupComplete) {
            return true;
        }

        const shouldSetup = await vscode.window.showInformationMessage(
            '🎉 LipCoder Extension에 오신 것을 환영합니다!\n\n' +
            '완벽한 환경 구축을 위해 자동 설정을 실행하시겠습니까?\n' +
            '(Node.js, Python 가상환경, 모든 dependencies 자동 설치)',
            { modal: true },
            '자동 설정 시작',
            '나중에 설정',
            '수동 설정 가이드'
        );

        switch (shouldSetup) {
            case '자동 설정 시작':
                return await this.runAutomaticSetup();
            case '수동 설정 가이드':
                await this.showManualSetupGuide();
                return false;
            default:
                return false;
        }
    }

    /**
     * 자동 설정 실행
     */
    private async runAutomaticSetup(): Promise<boolean> {
        return await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "🚀 LipCoder 환경 구축 중...",
            cancellable: false
        }, async (progress, token) => {
            try {
                const steps = [
                    { name: 'System Dependencies 확인', weight: 20 },
                    { name: 'Node.js 환경 설정', weight: 25 },
                    { name: 'Python 가상환경 생성', weight: 25 },
                    { name: 'Native Modules 빌드', weight: 20 },
                    { name: '최종 검증', weight: 10 }
                ];

                let currentProgress = 0;

                // 1. System Dependencies 확인
                progress.report({ increment: 0, message: "시스템 의존성 확인 중..." });
                await this.checkSystemDependencies();
                currentProgress += steps[0].weight;
                progress.report({ increment: steps[0].weight });

                // 2. Node.js 환경 설정
                progress.report({ increment: 0, message: "Node.js 환경 설정 중..." });
                await this.setupNodeEnvironment();
                currentProgress += steps[1].weight;
                progress.report({ increment: steps[1].weight });

                // 3. Python 가상환경 생성
                progress.report({ increment: 0, message: "Python 가상환경 생성 중..." });
                await this.setupPythonVirtualEnvironment();
                currentProgress += steps[2].weight;
                progress.report({ increment: steps[2].weight });

                // 4. Native Modules 빌드
                progress.report({ increment: 0, message: "Native modules 빌드 중..." });
                await this.buildNativeModules();
                currentProgress += steps[3].weight;
                progress.report({ increment: steps[3].weight });

                // 5. 최종 검증
                progress.report({ increment: 0, message: "설정 검증 중..." });
                await this.verifySetup();
                progress.report({ increment: steps[4].weight });

                // 설정 완료 표시
                await this.context.globalState.update('lipcoder.setupComplete', true);
                this.isSetupComplete = true;

                vscode.window.showInformationMessage(
                    '🎉 LipCoder 환경 구축이 완료되었습니다!\n\n' +
                    '이제 모든 기능을 사용할 수 있습니다.',
                    '확인'
                );

                return true;

            } catch (error) {
                logError(`[FirstTimeSetup] 자동 설정 실패: ${error}`);
                
                const retry = await vscode.window.showErrorMessage(
                    `❌ 자동 설정 중 오류가 발생했습니다:\n${error}\n\n다시 시도하시겠습니까?`,
                    '다시 시도',
                    '수동 설정 가이드',
                    '나중에'
                );

                if (retry === '다시 시도') {
                    return await this.runAutomaticSetup();
                } else if (retry === '수동 설정 가이드') {
                    await this.showManualSetupGuide();
                }

                return false;
            }
        });
    }

    /**
     * 시스템 의존성 확인 및 설치 (dependency_installer 활용)
     */
    private async checkSystemDependencies(): Promise<void> {
        logSuccess('[FirstTimeSetup] 기존 dependency_installer를 활용하여 시스템 의존성 확인 중...');
        
        // 기존 dependency_installer의 포괄적인 의존성 체크 활용
        await checkAndInstallAllDependencies();
        
        // 설치 상태 확인
        const status = await getDependencyStatus();
        const missingDeps = Object.entries(status)
            .filter(([_, installed]) => !installed)
            .map(([name, _]) => name);
            
        if (missingDeps.length > 0) {
            logWarning(`[FirstTimeSetup] 일부 의존성이 설치되지 않았습니다: ${missingDeps.join(', ')}`);
            throw new Error(`필수 의존성 설치 실패: ${missingDeps.join(', ')}`);
        }
        
        logSuccess('[FirstTimeSetup] 모든 시스템 의존성 확인 완료');
    }

    /**
     * Node.js 환경 설정
     */
    private async setupNodeEnvironment(): Promise<void> {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
            throw new Error('Workspace가 열려있지 않습니다.');
        }

        // NVM 설치 및 Node.js 20.18.2 설정
        try {
            await execAsync('command -v nvm');
        } catch {
            // NVM 설치
            await execAsync('curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.2/install.sh | bash');
        }

        // Node.js 20.18.2 설치 및 사용
        const nvmCommands = [
            'export NVM_DIR="$HOME/.nvm"',
            '[ -s "$NVM_DIR/nvm.sh" ] && \\. "$NVM_DIR/nvm.sh"',
            'nvm install 20.18.2',
            'nvm use 20.18.2',
            'nvm alias default 20.18.2'
        ].join(' && ');

        await execAsync(nvmCommands);

        // package.json의 정확한 버전으로 npm install
        await execAsync('npm install', { cwd: workspaceRoot });
    }

    /**
     * Python 가상환경 설정
     */
    private async setupPythonVirtualEnvironment(): Promise<void> {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
            throw new Error('Workspace가 열려있지 않습니다.');
        }

        const venvPath = path.join(workspaceRoot, 'server', 'venv');
        const requirementsPath = path.join(workspaceRoot, 'server', 'requirements_lipcoder.txt');

        // 가상환경 생성
        await execAsync(`python3 -m venv "${venvPath}"`);

        // 가상환경에서 requirements 설치
        const activateCmd = process.platform === 'win32' 
            ? `"${path.join(venvPath, 'Scripts', 'activate')}"` 
            : `source "${path.join(venvPath, 'bin', 'activate')}"`;

        await execAsync(`${activateCmd} && pip install --upgrade pip`);
        await execAsync(`${activateCmd} && pip install -r "${requirementsPath}"`);
    }

    /**
     * Native Modules 빌드
     */
    private async buildNativeModules(): Promise<void> {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
            throw new Error('Workspace가 열려있지 않습니다.');
        }

        // VS Code Extension Host의 Electron 버전에 맞게 빌드
        const electronVersion = '34.2.0'; // VS Code 1.98.2의 Electron 버전
        
        const nvmCommands = [
            'export NVM_DIR="$HOME/.nvm"',
            '[ -s "$NVM_DIR/nvm.sh" ] && \\. "$NVM_DIR/nvm.sh"',
            'nvm use 20.18.2',
            `npm rebuild node-pty --runtime=electron --target=${electronVersion} --dist-url=https://electronjs.org/headers --arch=arm64`,
            'npm rebuild speaker --build-from-source'
        ].join(' && ');

        await execAsync(nvmCommands, { cwd: workspaceRoot });

        // Debug 폴더 심볼릭 링크 생성
        const ptyBuildPath = path.join(workspaceRoot, 'node_modules', 'node-pty', 'build');
        if (fs.existsSync(ptyBuildPath)) {
            const debugPath = path.join(ptyBuildPath, 'Debug');
            const releasePath = path.join(ptyBuildPath, 'Release');
            
            if (fs.existsSync(releasePath) && !fs.existsSync(debugPath)) {
                await execAsync(`ln -sf Release Debug`, { cwd: ptyBuildPath });
            }
        }
    }

    /**
     * 설정 검증
     */
    private async verifySetup(): Promise<void> {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
            throw new Error('Workspace가 열려있지 않습니다.');
        }

        // Node.js 모듈 검증
        const nodeModules = ['node-pty', 'speaker', 'openai', 'diff', 'wav'];
        for (const module of nodeModules) {
            try {
                require.resolve(module, { paths: [workspaceRoot] });
                logSuccess(`[FirstTimeSetup] ${module} 모듈 검증 완료`);
            } catch (error) {
                throw new Error(`${module} 모듈을 찾을 수 없습니다: ${error}`);
            }
        }

        // Python 가상환경 검증
        const venvPath = path.join(workspaceRoot, 'server', 'venv');
        if (!fs.existsSync(venvPath)) {
            throw new Error('Python 가상환경이 생성되지 않았습니다.');
        }

        // Native 모듈 검증
        try {
            const pty = require('node-pty');
            if (typeof pty.spawn !== 'function') {
                throw new Error('node-pty가 올바르게 빌드되지 않았습니다.');
            }
            logSuccess('[FirstTimeSetup] node-pty 검증 완료');
        } catch (error) {
            logWarning(`[FirstTimeSetup] node-pty 검증 실패: ${error}`);
        }
    }

    /**
     * 수동 설정 가이드 표시
     */
    async showManualSetupGuide(): Promise<void> {
        const guideUri = vscode.Uri.file(
            path.join(this.context.extensionPath, 'MIGRATION_GUIDE.md')
        );
        
        await vscode.commands.executeCommand('markdown.showPreview', guideUri);
        
        vscode.window.showInformationMessage(
            '📖 수동 설정 가이드가 열렸습니다.\n\n' +
            'MIGRATION_GUIDE.md 파일의 지침을 따라 설정해주세요.',
            '확인'
        );
    }

    /**
     * 설정 상태 확인
     */
    isSetupCompleted(): boolean {
        return this.isSetupComplete;
    }

    /**
     * 설정 재실행
     */
    async resetAndRerunSetup(): Promise<void> {
        await this.context.globalState.update('lipcoder.setupComplete', false);
        this.isSetupComplete = false;
        await this.checkAndRunFirstTimeSetup();
    }
}

/**
 * VS Code 명령어 등록
 */
export function registerFirstTimeSetupCommands(context: vscode.ExtensionContext): vscode.Disposable[] {
    const setup = new FirstTimeSetup(context);
    
    return [
        vscode.commands.registerCommand('lipcoder.runFirstTimeSetup', async () => {
            await setup.checkAndRunFirstTimeSetup();
        }),
        
        vscode.commands.registerCommand('lipcoder.resetSetup', async () => {
            const confirm = await vscode.window.showWarningMessage(
                '⚠️ 설정을 초기화하고 다시 실행하시겠습니까?\n\n' +
                '이 작업은 되돌릴 수 없습니다.',
                { modal: true },
                '초기화 후 재실행',
                '취소'
            );
            
            if (confirm === '초기화 후 재실행') {
                await setup.resetAndRerunSetup();
            }
        }),
        
        vscode.commands.registerCommand('lipcoder.checkSetupStatus', async () => {
            const isComplete = setup.isSetupCompleted();
            const message = isComplete 
                ? '✅ LipCoder 환경 설정이 완료되었습니다.'
                : '❌ LipCoder 환경 설정이 필요합니다.';
                
            const action = isComplete ? '재설정' : '설정 시작';
            
            const result = await vscode.window.showInformationMessage(
                message,
                action,
                '설정 가이드'
            );
            
            if (result === action) {
                if (isComplete) {
                    await setup.resetAndRerunSetup();
                } else {
                    await setup.checkAndRunFirstTimeSetup();
                }
            } else if (result === '설정 가이드') {
                await setup.showManualSetupGuide();
            }
        })
    ];
}

// Extension activation 시 자동 실행을 위한 export는 위에서 이미 완료됨
