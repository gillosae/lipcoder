// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { LanguageClient, ServerOptions, TransportKind, LanguageClientOptions } from 'vscode-languageclient/node';
import * as path from 'path';
import { SymbolInformation } from 'vscode-languageserver-types';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
// export function activate(context: vscode.ExtensionContext) {

// Use the console to output diagnostic information (console.log) and errors (console.error)
// This line of code will only be executed once when your extension is activated 
console.log('Congratulations, your extension "lipcoder" is now active!');
// The command has been defined in the package.json file
// Now provide the implementation of the command with registerCommand
// The commandId parameter must match the command field in package.json

console.log("🚀 LipCoder.activate() called");
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
	client.start().catch(err => console.error(err));

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
			} else {
				// 3. Speak it out
				const symbol = containing[0];
				const container = symbol.containerName ? `${symbol.containerName} → ` : '';
				const msg = `${container}${symbol.name}`;
				vscode.window.showInformationMessage(`You are in: ${msg}`);
				// TODO: integrate your TTS/beep here, e.g. speak(msg);
			}
		})
	);

}

// This method is called when your extension is deactivated
export function deactivate() { }
