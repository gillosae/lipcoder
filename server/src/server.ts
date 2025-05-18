import {
    createConnection,
    ProposedFeatures,
    InitializeParams,
    InitializeResult
} from 'vscode-languageserver/node';

import { TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import * as ts from 'typescript';

import {
    SymbolInformation,
    SymbolKind
} from 'vscode-languageserver-types';

const connection = createConnection(ProposedFeatures.all);

const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);
documents.listen(connection);

// 1. Log on initialize so we know the server launched
connection.onInitialize((_params: InitializeParams): InitializeResult => {
    connection.console.log('🛠️  LipCoder server initialized');
    return {
        capabilities: {
            documentSymbolProvider: true,
        }
    };
});

// 2. A simple custom request: echo back whatever the client sends
connection.onRequest('lipcoder/echo', (payload: { text: string }) => {
    return { text: `pong: ${payload.text}` };
});



function getDocumentSymbols(text: string): SymbolInformation[] {
    const sourceFile = ts.createSourceFile('file.ts', text, ts.ScriptTarget.Latest, true);
    const symbols: SymbolInformation[] = [];

    function walk(node: ts.Node, containerName?: string) {
        let kind: SymbolKind | undefined;
        let name: string | undefined;

        if (ts.isFunctionDeclaration(node) && node.name) {
            kind = SymbolKind.Function;
            name = node.name.getText();
        } else if (ts.isClassDeclaration(node) && node.name) {
            kind = SymbolKind.Class;
            name = node.name.getText();
        } else if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
            kind = SymbolKind.Method;
            name = node.name.getText();
        } else if (ts.isVariableStatement(node)) {
            kind = SymbolKind.Variable;
            // for simplicity only take the first declaration
            if (node.declarationList.declarations[0].name) {
                name = node.declarationList.declarations[0].name.getText();
            }
        }

        if (kind && name) {
            const { line: startLine, character: startChar } =
                sourceFile.getLineAndCharacterOfPosition(node.getStart());
            const { line: endLine, character: endChar } =
                sourceFile.getLineAndCharacterOfPosition(node.getEnd());

            symbols.push({
                name,
                kind,
                location: {
                    uri: '',      // will be filled by the LSP framework
                    range: {
                        start: { line: startLine, character: startChar },
                        end: { line: endLine, character: endChar }
                    }
                },
                containerName
            });

            // Use this symbol’s name as the container for its children
            containerName = name;
        }

        node.forEachChild(child => walk(child, containerName));
    }

    walk(sourceFile);
    return symbols;
}

connection.onDocumentSymbol(params => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) {
        connection.console.error(`Document not found: ${params.textDocument.uri}`);
        return [];
    }
    const text = doc.getText();
    const syms = getDocumentSymbols(text);
    // fill in the URI now that LSP gives it to us:
    return syms.map(sym => ({ ...sym, location: { ...sym.location, uri: params.textDocument.uri } }));
});

connection.listen();