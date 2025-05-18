import * as vscode from 'vscode'; // VS Code extensibility API
import { LanguageClient, ServerOptions, TransportKind, LanguageClientOptions } from 'vscode-languageclient/node';
import * as path from 'path';
import { SymbolInformation } from 'vscode-languageserver-types';
import { speak, beepSound } from './audio';

export function activate(context: vscode.ExtensionContext) {
	// 1. Point to the compiled server bundle
	const serverModule = context.asAbsolutePath(path.join('dist', 'server', 'server.js'));

	const serverOpts: ServerOptions = {
		run: { module: serverModule, transport: TransportKind.stdio },
		debug: { module: serverModule, transport: TransportKind.stdio, options: { execArgv: ['--inspect=6009'] } }
	};

	// 2. Tell the client which files to “watch”
	const clientOpts: LanguageClientOptions = {
		documentSelector: [{ scheme: 'file', language: '*' }],
		synchronize: { fileEvents: vscode.workspace.createFileSystemWatcher('**/*') }
	};

	const client = new LanguageClient('lipcoder', 'LipCoder LSP', serverOpts, clientOpts);
	context.subscriptions.push({
		dispose: () => {
			client.stop();
		}
	});
	// client.start().catch(err => console.error(err));
	const disposableClient = client.start();
	context.subscriptions.push({
		dispose: () => disposableClient.then(() => { })
	});

	client.start().then(() => {
		// register echoTest, whereAmI, readLineTokens here
	}).catch(err => console.error('LSP client failed to start:', err));

	// 3. Test our echo request via a command
	context.subscriptions.push(
		vscode.commands.registerCommand('lipcoder.echoTest', async () => {
			const res = await client.sendRequest<{ text: string }>('lipcoder/echo', { text: 'hello' });
			vscode.window.showInformationMessage(res.text);
		}),
		vscode.commands.registerCommand('lipcoder.whereAmI', async () => {
			// 1. Ask the server for all symbols in this document
			const uri = vscode.window.activeTextEditor?.document.uri.toString();
			if (!uri) {
				vscode.window.showWarningMessage('No active editor!');
				return;
			}

			const result = await client.sendRequest<SymbolInformation[]>('textDocument/documentSymbol', {
				textDocument: { uri }
			});

			// 2. Find the deepest symbol containing the cursor
			const pos = vscode.window.activeTextEditor!.selection.active;
			const containing = result
				.filter(s => {
					const r = s.location.range;
					return (
						(pos.line > r.start.line || (pos.line === r.start.line && pos.character >= r.start.character)) &&
						(pos.line < r.end.line || (pos.line === r.end.line && pos.character <= r.end.character))
					);
				})
				// Sort by span (smallest range first)
				.sort((a, b) => {
					const lenA = (a.location.range.end.line - a.location.range.start.line);
					const lenB = (b.location.range.end.line - b.location.range.start.line);
					return lenA - lenB;
				});

			if (containing.length === 0) {
				vscode.window.showInformationMessage('Outside of any symbol.');
				speak("You are outside of any symbol.");
			} else {
				// 3. Speak it out
				const symbol = containing[0];
				const container = symbol.containerName ? `${symbol.containerName} → ` : '';
				const msg = `${container}${symbol.name}`;
				vscode.window.showInformationMessage(`You are in: ${msg}`);
				speak(`You are in ${msg}`);        // so espeak will vocalize it
				vscode.window.showInformationMessage(`You are in: ${msg}`);
			}
		}),
		vscode.commands.registerCommand('lipcoder.readLineTokens', async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				vscode.window.showWarningMessage('No active editor!');
				return;
			}
			vscode.window.showInformationMessage('Starting readLineTokens command...');
			const uri = editor.document.uri.toString();
			const line = editor.selection.active.line;
			const tokens = await client.sendRequest<{ text: string; category: string }[]>(
				'lipcoder/readLineTokens',
				{ uri, line }
			);
			vscode.window.showInformationMessage(`Found ${tokens.length} tokens on line ${line}`);
			for (let i = 0; i < tokens.length; i++) {
				const { text, category } = tokens[i];
				let pitch = 50;
				let voice = 'en-us';
				switch (category) {
					case 'keyword': pitch = 90; voice = 'en-us+m3'; break;
					case 'type': pitch = 70; voice = 'en-us+f3'; break;
					case 'literal': pitch = 40; voice = 'en-us+f2'; break;
					case 'variable': pitch = 60; voice = 'en-us'; break;
				}
				try {
					await speak(text, { voice, pitch, gap: 0, speed: 250, beep: false });
				} catch (err: any) {
					vscode.window.showErrorMessage(`Error speaking token "${text}": ${err.message}`);
				}
				// beep between words (0.2s duration assumed by audio file)
				if (i < tokens.length - 1) {
					await beepSound();
				}
			}
			vscode.window.showInformationMessage('Finished reading tokens');
		})
	);

}


export function deactivate() { } // called when your extension is deactivated
