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

// Helper function to tokenize comment text that may contain backslash commands
function tokenizeCommentText(text: string): Array<{ text: string; category: string }> {
    const tokens: Array<{ text: string; category: string }> = [];
    
    // Split on backslashes while preserving the backslashes
    const parts = text.split(/(\\\w+)/);
    
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (!part) continue; // Skip empty parts
        
        if (part.startsWith('\\')) {
            // This is a backslash command like \emph
            tokens.push({ text: '\\', category: 'comment_symbol' });
            const command = part.slice(1); // Remove the backslash
            if (command) {
                tokens.push({ text: command, category: 'comment_text' });
            }
        } else {
            // Regular text - keep as single unit if non-empty
            if (part.trim()) {
                tokens.push({ text: part, category: 'comment_text' });
            }
        }
    }
    
    return tokens;
}

// Helper function to tokenize comments properly
function tokenizeComment(commentText: string): Array<{ text: string; category: string }> {
    const tokens: Array<{ text: string; category: string }> = [];
    
    // Match comment patterns like "# 2) Some descriptive text"
    const commentMatch = commentText.match(/^(\s*)(#|\/\/)\s*([0-9]*)\s*([)}\]]*)\s*(.*)$/);
    
    if (commentMatch) {
        const [, leadingSpace, commentChar, number, closingChars, description] = commentMatch;
        
        // Add leading whitespace if present
        if (leadingSpace) {
            tokens.push({ text: leadingSpace, category: 'whitespace' });
        }
        
        // Add comment symbol
        tokens.push({ text: commentChar, category: 'comment_symbol' });
        
        // Add space after comment symbol if it was there
        const afterCommentMatch = commentText.match(/^(\s*)(#|\/\/)\s+/);
        if (afterCommentMatch) {
            tokens.push({ text: ' ', category: 'whitespace' });
        }
        
        // Add number if present
        if (number) {
            tokens.push({ text: number, category: 'comment_number' });
            // Add space after number if description follows
            if (closingChars || description.trim()) {
                tokens.push({ text: ' ', category: 'whitespace' });
            }
        }
        
        // Add closing characters individually (like ), }, ])
        for (const char of closingChars) {
            tokens.push({ text: char, category: 'comment_symbol' });
        }
        
        // Add space before description if present
        if (closingChars && description.trim()) {
            tokens.push({ text: ' ', category: 'whitespace' });
        }
        
        // Add the descriptive text, but further tokenize backslash commands
        if (description.trim()) {
            const textTokens = tokenizeCommentText(description.trim());
            tokens.push(...textTokens);
        }
    } else {
        // Fallback: treat as regular comment
        tokens.push({ text: commentText, category: 'comment' });
    }
    
    return tokens;
}

// 3. Handle readLineTokens requests for tokenizing a specific line
connection.onRequest('lipcoder/readLineTokens', (params: { uri: string; line: number }) => {
    const doc = documents.get(params.uri);
    if (!doc) return [];
    const text = doc.getText();
    const lines = text.split(/\r?\n/);
    const lineText = lines[params.line] || '';
    
    // Check if this is a comment line first
    const trimmedLine = lineText.trim();
    if (trimmedLine.startsWith('#') || trimmedLine.startsWith('//')) {
        return tokenizeComment(lineText);
    }
    
    // For non-comment lines, use the regular TypeScript scanner
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, lineText);

    const tokens: Array<{ text: string; category: string }> = [];
    let kind = scanner.scan();
    while (kind !== ts.SyntaxKind.EndOfFileToken) {
        const tokenText = scanner.getTokenText();
        let category = 'other';
        if (kind === ts.SyntaxKind.Identifier) {
            category = 'variable';
        } else if (kind === ts.SyntaxKind.StringLiteral || kind === ts.SyntaxKind.NumericLiteral) {
            category = 'literal';
        } else if (ts.SyntaxKind[kind].includes('Keyword')) {
            category = 'keyword';
        } else if (kind === ts.SyntaxKind.TypeReference) {
            category = 'type';
        }
        tokens.push({ text: tokenText, category });
        kind = scanner.scan();
    }
    return tokens;
});

connection.listen();
