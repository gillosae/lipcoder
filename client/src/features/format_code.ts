import * as vscode from 'vscode';
import { speakToken } from '../audio';
import { lipcoderLog } from '../logger';
import * as cp from 'child_process';
import { installDependencies } from '../install_dependencies';

export function registerFormatCode(context: vscode.ExtensionContext) {
    const selector: vscode.DocumentSelector = [
        { language: 'python', scheme: 'file' },
        { language: 'javascript', scheme: 'file' },
        { language: 'typescript', scheme: 'file' },
    ];

    lipcoderLog.appendLine('👺 Feature: registering lipcoder.formatCode command');

    // Command to explicitly format the current document
    context.subscriptions.push(
        vscode.commands.registerCommand('lipcoder.formatCode', async () => {
            lipcoderLog.appendLine('Command lipcoder.formatCode invoked');
            try {
                const editor = vscode.window.activeTextEditor;
                if (!editor) {
                    vscode.window.showWarningMessage('No active editor to format');
                    return;
                }

                if (editor.document.languageId === 'python') {
                    try {
                        await new Promise<void>((resolve, reject) => {
                            const proc = cp.spawn('black', [editor.document.uri.fsPath], { stdio: 'inherit' });
                            proc.on('error', err => reject(err));
                            proc.on('exit', code => code === 0 ? resolve() : reject(new Error(`black exited ${code}`)));
                        });
                        await editor.document.save();
                        await vscode.commands.executeCommand('workbench.action.files.revert');
                        vscode.window.showInformationMessage('Document formatted with Black');
                        await speakToken("Document formatted with Black");
                        return;
                    } catch (err: any) {
                        console.error('Error running Black:', err);
                        if (err.code === 'ENOENT') {
                            lipcoderLog.appendLine('Black not found, prompting installation.');
                            const installChoice = await vscode.window.showInformationMessage(
                                'Black is not installed. Install now?',
                                'Install'
                            );
                            if (installChoice === 'Install') {
                                await installDependencies();
                                vscode.window.showInformationMessage('Black installed. Please re-run formatting.');
                            }
                            return;
                        }
                        vscode.window.showErrorMessage(`Black formatting failed: ${err}`);
                        return;
                    }
                }

                if (editor.document.languageId === 'javascript' || editor.document.languageId === 'typescript') {
                    try {
                        await new Promise<void>((resolve, reject) => {
                            const proc = cp.spawn('prettier', ['--write', editor.document.uri.fsPath], { stdio: 'inherit' });
                            proc.on('error', err => reject(err));
                            proc.on('exit', code => code === 0 ? resolve() : reject(new Error(`prettier exited ${code}`)));
                        });
                        await editor.document.save();
                        await vscode.commands.executeCommand('workbench.action.files.revert');
                        vscode.window.showInformationMessage('Document formatted with Prettier');
                        await speakToken("Document formatted with Prettier");
                        return;
                    } catch (err) {
                        console.error('Error running Prettier:', err);
                        vscode.window.showErrorMessage(`Prettier formatting failed: ${err}`);
                        return;
                    }
                }

                const edits = (await vscode.commands.executeCommand(
                    'vscode.executeFormatDocumentProvider',
                    editor.document.uri,
                    {}
                )) as vscode.TextEdit[];

                console.log('🛠️ formatCode edits:', edits);
                console.log('🛠️ edits length:', edits ? edits.length : 'no edits');

                if (edits.length) {
                    const workspaceEdit = new vscode.WorkspaceEdit();
                    edits.forEach(edit =>
                        workspaceEdit.replace(editor.document.uri, edit.range, edit.newText)
                    );
                    await vscode.workspace.applyEdit(workspaceEdit);
                    await editor.document.save();
                    vscode.window.showInformationMessage('Document formatted');
                    await speakToken("Document formatted");
                } else {
                    vscode.window.showInformationMessage('Nothing to format');
                    await speakToken("Nothing to format");
                }
            } catch (err: any) {
                if (err.name === 'Canceled') {
                    vscode.window.showInformationMessage('Format canceled');
                } else {
                    console.error('Error during formatCode:', err);
                    vscode.window.showErrorMessage(`Format Code failed: ${err}`);
                }
            } finally {
                lipcoderLog.appendLine('🛠️ formatCode handler completed');
            }
        })
    );

    // Register ourselves as a formatting provider so “Format Document” (⇧⌥F / Shift+Alt+F) works
    context.subscriptions.push(
        vscode.languages.registerDocumentFormattingEditProvider(selector, {
            async provideDocumentFormattingEdits(document: vscode.TextDocument) {
                await vscode.commands.executeCommand('lipcoder.formatCode');
                return [];
                // return vscode.commands.executeCommand(
                //     'vscode.executeFormatDocumentProvider',
                //     document.uri,
                //     {}
                // ) as Thenable<vscode.TextEdit[]>;
            },
        })
    );
}