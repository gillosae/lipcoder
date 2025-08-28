import * as vscode from 'vscode';
import { speakTokenList, speakGPT, TokenChunk } from '../audio';
import { lipcoderLog } from '../logger';
import * as cp from 'child_process';
import { installDependencies } from '../install_dependencies';

// Helper to promisify spawn for running CLI tools and CAPTURE output
async function spawnCapture(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = cp.spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()))
    child.stderr.on('data', (d) => (stderr += d.toString()))
    child.on('error', (err) => reject(err));
    child.on('exit', (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      const err: any = new Error(`${cmd} exited ${code}`);
      err.code = code;
      err.stdout = stdout;
      err.stderr = stderr;
      return reject(err);
    });
  });
}

// Helper to run Black on a given file, robustly trying interpreters and PATH
async function runBlackOnFile(filePath: string): Promise<{ stdout: string; stderr: string }> {
  const cfg = vscode.workspace.getConfiguration('python');
  const interp = (cfg.get<string>('defaultInterpreterPath') || '').trim();
  const candidates: Array<{ cmd: string; args: string[]; label: string }> = [];

  if (interp) {
    candidates.push({ cmd: interp, args: ['-m', 'black', filePath], label: `${interp} -m black` });
  }
  candidates.push(
    { cmd: 'python3', args: ['-m', 'black', filePath], label: 'python3 -m black' },
    { cmd: 'python', args: ['-m', 'black', filePath], label: 'python -m black' },
    { cmd: 'black', args: [filePath], label: 'black' }
  );

  let lastErr: any = null;
  for (const c of candidates) {
    try {
      const out = await spawnCapture(c.cmd, c.args);
      return out; // success
    } catch (err: any) {
      lastErr = err;
      // If interpreter exists but doesn't have Black installed OR binary not found, try next candidate
      const stderr = String(err?.stderr || '');
      if (
        err?.code === 'ENOENT' ||
        /not found|is not recognized/i.test(String(err)) ||
        /No module named black/i.test(stderr)
      ) {
        continue;
      }
      // If Black returned non-zero for other reasons, propagate detailed error
      throw err;
    }
  }
  const e: any = new Error('Black not found in configured interpreter or PATH');
  e.code = 'ENOENT';
  throw e;
}

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
                    const { stdout, stderr } = await runBlackOnFile(editor.document.uri.fsPath);
                    // Save & reload to reflect changes on disk
                    await editor.document.save();
                    await vscode.commands.executeCommand('workbench.action.files.revert');
                    const note = stdout?.trim() ? `Document formatted with Black.\n${stdout.trim()}` : 'Document formatted with Black';
                    vscode.window.showInformationMessage('Document formatted with Black');
                    await speakGPT("Document formatted with Black");
                    // Also log stderr in case Black emitted warnings
                    if (stderr?.trim()) {
                      lipcoderLog.appendLine(`Black warnings:\n${stderr.trim()}`);
                    }
                    return;
                  } catch (err: any) {
                    console.error('Error running Black:', err);
                    // Syntax errors commonly yield exit code 1 with helpful stderr
                    if (typeof err?.code === 'number' && err.code !== 0 && err.stderr) {
                      const msg = err.stderr.toString();
                      lipcoderLog.appendLine(`Black error (exit ${err.code}):\n${msg}`);
                      vscode.window.showErrorMessage(`Black failed (exit ${err.code}). See LipCoder Output for details.`);
                      // If parse error, hint the likely cause
                      if (/cannot parse|parse error|SyntaxError/i.test(msg)) {
                        vscode.window.showInformationMessage('Black cannot format due to a syntax error. Fix syntax first, then format again.');
                      }
                      return;
                    }
                    if (err?.code === 'ENOENT') {
                      lipcoderLog.appendLine('Black not found via configured interpreter or PATH. Prompting installation.');
                      const installChoice = await vscode.window.showInformationMessage(
                        'Black is not installed or not on the current PATH. Install now?',
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
                        await speakGPT("Document formatted with Prettier");
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
                    await speakGPT("Document formatted");
                } else {
                    vscode.window.showInformationMessage('Nothing to format');
                    await speakGPT("Nothing to format");
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