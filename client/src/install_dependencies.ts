import * as vscode from 'vscode';
import * as cp from 'child_process';
import { lipcoderLog } from './logger';

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
 * Installs or prompts to install Black and Prettier.
 */
export async function installDependencies(): Promise<void> {
    await ensureToolAvailable('black', ['pip', 'install', '--user', 'black'], 'Black');
    await ensureToolAvailable('prettier', ['npm', 'install', '-g', 'prettier'], 'Prettier');
}
