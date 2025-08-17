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

// Simplified tokenization - just return characters/words without complex categorization
// Let the client handle categorization based on its own logic
function tokenizeComplexText(text: string): Array<{ text: string; category: string }> {
    const tokens: Array<{ text: string; category: string }> = [];
    let i = 0;
    
    while (i < text.length) {
        const char = text[i];
        
        if (/\s/.test(char)) {
            // Whitespace - skip it (don't tokenize spaces in complex text)
            i++;
        } else if (/[a-zA-Z0-9]/.test(char)) {
            // Alphanumeric - collect as word
            let word = '';
            while (i < text.length && /[a-zA-Z0-9]/.test(text[i])) {
                word += text[i];
                i++;
            }
            if (word) {
                tokens.push({ text: word, category: 'variable' });
            }
        } else {
            // All other characters - let client decide categorization
            tokens.push({ text: char, category: 'unknown' });
            i++;
        }
    }
    
    return tokens;
}

// Helper function to tokenize comment text that may contain backslash commands
function tokenizeCommentText(text: string): Array<{ text: string; category: string }> {
    const tokens: Array<{ text: string; category: string }> = [];
    let i = 0;
    
    while (i < text.length) {
        const char = text[i];
        
        if (char === '\\') {
            // Backslash symbol - use 'comment_symbol' category for earcon
            tokens.push({ text: char, category: 'comment_symbol' });
            i++;
        } else if (char === '_') {
            // Underscore symbol - use 'comment_symbol' category so it plays as earcon
            tokens.push({ text: char, category: 'comment_symbol' });
            i++;
        } else if (char === '.' || char === ',' || char === ';' || char === ':') {
            // Punctuation symbols - use 'comment_symbol' category so they play as earcons
            tokens.push({ text: char, category: 'comment_symbol' });
            i++;
        } else if (char === '(' || char === ')' || char === '[' || char === ']' || 
                   char === '{' || char === '}') {
            // Bracket symbols - use 'comment_symbol' category so they play as earcons
            tokens.push({ text: char, category: 'comment_symbol' });
            i++;
        } else if (char === '"' || char === "'" || char === '`') {
            // Quote symbols - use 'comment_symbol' category so they play as earcons
            tokens.push({ text: char, category: 'comment_symbol' });
            i++;
        } else if (/\s/.test(char)) {
            // Whitespace - skip it (don't tokenize spaces in comment text)
            i++;
        } else if (/[a-zA-Z0-9]/.test(char)) {
            // Alphanumeric - collect as word and use 'comment_text' category for comment voice
            let word = '';
            while (i < text.length && /[a-zA-Z0-9]/.test(text[i])) {
                word += text[i];
                i++;
            }
            if (word) {
                // Use 'comment_text' category so words are spoken with comment voice
                tokens.push({ text: word, category: 'comment_text' });
            }
        } else {
            // Other characters - treat as symbols with 'comment_symbol' category
            tokens.push({ text: char, category: 'comment_symbol' });
            i++;
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

// Helper function to find comment position while respecting string boundaries
function findCommentPosition(text: string): number {
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let inBacktick = false;
    let i = 0;
    
    while (i < text.length) {
        const char = text[i];
        const nextChar = text[i + 1];
        
        // Handle escape sequences
        if (char === '\\' && (inSingleQuote || inDoubleQuote || inBacktick)) {
            i += 2; // Skip escaped character
            continue;
        }
        
        // Toggle string states
        if (char === "'" && !inDoubleQuote && !inBacktick) {
            inSingleQuote = !inSingleQuote;
        } else if (char === '"' && !inSingleQuote && !inBacktick) {
            inDoubleQuote = !inDoubleQuote;
        } else if (char === '`' && !inSingleQuote && !inDoubleQuote) {
            inBacktick = !inBacktick;
        }
        
        // Check for comments only when not inside strings
        if (!inSingleQuote && !inDoubleQuote && !inBacktick) {
            // Check for // comment
            if (char === '/' && nextChar === '/') {
                return i;
            }
            // Check for # comment
            if (char === '#') {
                return i;
            }
            // Check for /* comment (basic check for start)
            if (char === '/' && nextChar === '*') {
                return i;
            }
        }
        
        i++;
    }
    
    return -1; // No comment found
}

// 3. Handle readLineTokens requests for tokenizing a specific line
connection.onRequest('lipcoder/readLineTokens', (params: { uri: string; line: number }) => {
    const doc = documents.get(params.uri);
    if (!doc) return [];
    const text = doc.getText();
    const lines = text.split(/\r?\n/);
    const lineText = lines[params.line] || '';
    
    // Check if this is a full comment line first
    const trimmedLine = lineText.trim();
    if (trimmedLine.startsWith('#') || trimmedLine.startsWith('//') || 
        trimmedLine.startsWith('/*') || trimmedLine.startsWith('/**') ||
        trimmedLine.startsWith(' *') || trimmedLine.startsWith('*')) {
        return tokenizeComment(lineText);
    }
    
    // For mixed lines (code + inline comments), we need to handle them carefully
    const tokens: Array<{ text: string; category: string }> = [];
    
    // Find inline comment positions using string-aware parsing
    const commentPosition = findCommentPosition(lineText);
    
    if (commentPosition !== -1) {
        // Split line at comment position
        const beforeComment = lineText.substring(0, commentPosition);
        const commentPart = lineText.substring(commentPosition);
        
        // Process the code part before the comment
        if (beforeComment.trim()) {
            const codeTokens = scanCodeTokens(beforeComment);
            tokens.push(...codeTokens);
        }
        
        // Process the comment part
        const commentTokens = tokenizeComment(commentPart);
        tokens.push(...commentTokens);
        
    } else {
        // No inline comments, process the entire line as code
        const codeTokens = scanCodeTokens(lineText);
        tokens.push(...codeTokens);
    }
    
    return tokens;
});

// Helper function to scan code tokens using TypeScript scanner
function scanCodeTokens(codeText: string): Array<{ text: string; category: string }> {
    // Check if this looks like complex LaTeX-like syntax that needs special handling
    if (codeText.includes('\\') && (codeText.includes('{') || codeText.includes('_')) && 
        (codeText.includes('{{{') || codeText.match(/\\\w+_\w+/))) {
        return tokenizeComplexText(codeText);
    }
    
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, codeText);
    const tokens: Array<{ text: string; category: string }> = [];
    
    let kind = scanner.scan();
    while (kind !== ts.SyntaxKind.EndOfFileToken) {
        const tokenText = scanner.getTokenText();
        let category = 'other';
        
        if (kind === ts.SyntaxKind.Identifier) {
            category = 'variable';
        } else if (kind === ts.SyntaxKind.StringLiteral || kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral) {
            // Separate quotes from string content 
            const stringContent = tokenText;
            
            // Add opening quote - let client decide categorization
            if (stringContent.startsWith('"') || stringContent.startsWith("'") || stringContent.startsWith('`')) {
                tokens.push({ text: stringContent[0], category: 'unknown' });
            }
            
            // Add string content (without quotes) - check if it needs complex tokenization
            const innerContent = stringContent.slice(1, -1); // Remove quotes
            if (innerContent) {
                if (innerContent.includes('\\') && (innerContent.includes('{') || innerContent.includes('_'))) {
                    // Complex content inside string - tokenize individually
                    const complexTokens = tokenizeComplexText(innerContent);
                    tokens.push(...complexTokens);
                } else {
                    tokens.push({ text: innerContent, category: 'literal' });
                }
            }
            
            // Add closing quote - let client decide categorization
            if (stringContent.endsWith('"') || stringContent.endsWith("'") || stringContent.endsWith('`')) {
                tokens.push({ text: stringContent[stringContent.length - 1], category: 'unknown' });
            }
            
            // Skip to next token since we've already processed this string literal
            kind = scanner.scan();
            continue;
        } else if (kind === ts.SyntaxKind.TemplateHead || kind === ts.SyntaxKind.TemplateMiddle || kind === ts.SyntaxKind.TemplateTail) {
            category = 'literal';
        } else if (kind === ts.SyntaxKind.NumericLiteral) {
            category = 'literal';
        } else if (ts.SyntaxKind[kind].includes('Keyword')) {
            category = 'keyword';
        } else if (kind === ts.SyntaxKind.TypeReference) {
            category = 'type';
        } else if (isOperatorToken(kind)) {
            category = 'operator';
        } else if (isPunctuationToken(kind)) {
            category = 'unknown'; // Let client handle punctuation categorization
        }
        
        tokens.push({ text: tokenText, category });
        kind = scanner.scan();
    }
    
    return tokens;
}

// Helper function to identify operator tokens
function isOperatorToken(kind: ts.SyntaxKind): boolean {
    return [
        ts.SyntaxKind.PlusToken,                    // +
        ts.SyntaxKind.MinusToken,                   // -
        ts.SyntaxKind.AsteriskToken,                // *
        ts.SyntaxKind.SlashToken,                   // /
        ts.SyntaxKind.PercentToken,                 // %
        ts.SyntaxKind.AsteriskAsteriskToken,        // **
        ts.SyntaxKind.EqualsToken,                  // =
        ts.SyntaxKind.EqualsEqualsToken,            // ==
        ts.SyntaxKind.EqualsEqualsEqualsToken,      // ===
        ts.SyntaxKind.ExclamationEqualsToken,       // !=
        ts.SyntaxKind.ExclamationEqualsEqualsToken, // !==
        ts.SyntaxKind.LessThanToken,                // <
        ts.SyntaxKind.GreaterThanToken,             // >
        ts.SyntaxKind.LessThanEqualsToken,          // <=
        ts.SyntaxKind.GreaterThanEqualsToken,       // >=
        ts.SyntaxKind.AmpersandToken,               // &
        ts.SyntaxKind.AmpersandAmpersandToken,      // &&
        ts.SyntaxKind.BarToken,                     // |
        ts.SyntaxKind.BarBarToken,                  // ||
        ts.SyntaxKind.CaretToken,                   // ^
        ts.SyntaxKind.TildeToken,                   // ~
        ts.SyntaxKind.ExclamationToken,             // !
        ts.SyntaxKind.QuestionToken,                // ?
        ts.SyntaxKind.PlusEqualsToken,              // +=
        ts.SyntaxKind.MinusEqualsToken,             // -=
        ts.SyntaxKind.AsteriskEqualsToken,          // *=
        ts.SyntaxKind.SlashEqualsToken,             // /=
        ts.SyntaxKind.PercentEqualsToken,           // %=
        ts.SyntaxKind.AmpersandEqualsToken,         // &=
        ts.SyntaxKind.BarEqualsToken,               // |=
        ts.SyntaxKind.CaretEqualsToken,             // ^=
        ts.SyntaxKind.LessThanLessThanToken,        // <<
        ts.SyntaxKind.GreaterThanGreaterThanToken,  // >>
        ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken, // >>>
        ts.SyntaxKind.LessThanLessThanEqualsToken,  // <<=
        ts.SyntaxKind.GreaterThanGreaterThanEqualsToken, // >>=
        ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken, // >>>=
        ts.SyntaxKind.QuestionQuestionToken,        // ??
        ts.SyntaxKind.QuestionQuestionEqualsToken,  // ??=
        ts.SyntaxKind.PlusPlusToken,                // ++
        ts.SyntaxKind.MinusMinusToken,              // --
    ].includes(kind);
}

// Helper function to identify punctuation/structural tokens
function isPunctuationToken(kind: ts.SyntaxKind): boolean {
    return [
        ts.SyntaxKind.OpenParenToken,        // (
        ts.SyntaxKind.CloseParenToken,       // )
        ts.SyntaxKind.OpenBraceToken,        // {
        ts.SyntaxKind.CloseBraceToken,       // }
        ts.SyntaxKind.OpenBracketToken,      // [
        ts.SyntaxKind.CloseBracketToken,     // ]
        ts.SyntaxKind.CommaToken,            // ,
        ts.SyntaxKind.SemicolonToken,        // ;
        ts.SyntaxKind.ColonToken,            // :
        ts.SyntaxKind.DotToken,              // .
        ts.SyntaxKind.AtToken,               // @
        ts.SyntaxKind.HashToken,             // #
        ts.SyntaxKind.BacktickToken,         // `
    ].includes(kind);
}

connection.listen();
