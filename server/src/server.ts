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

/**
 * Check if character is Korean
 */
function isKoreanChar(char: string): boolean {
    const code = char.charCodeAt(0);
    return (code >= 0xAC00 && code <= 0xD7AF) ||  // Hangul Syllables
           (code >= 0x1100 && code <= 0x11FF) ||  // Hangul Jamo
           (code >= 0x3130 && code <= 0x318F) ||  // Hangul Compatibility Jamo
           (code >= 0xA960 && code <= 0xA97F) ||  // Hangul Jamo Extended-A
           (code >= 0xD7B0 && code <= 0xD7FF);    // Hangul Jamo Extended-B
}



// Helper function to check if we're at the start of a regex pattern
function isRegexStart(text: string, index: number): { isRegex: boolean; endIndex: number; pattern: string } {
    // Check for r'...' or r"..." pattern
    if (index < text.length - 1 && text[index] === 'r' && (text[index + 1] === "'" || text[index + 1] === '"')) {
        const quote = text[index + 1];
        let endIndex = index + 2;
        
        // Find the closing quote
        while (endIndex < text.length && text[endIndex] !== quote) {
            endIndex++;
        }
        
        if (endIndex < text.length) {
            return {
                isRegex: true,
                endIndex: endIndex,
                pattern: text.substring(index, endIndex + 1)
            };
        }
    }
    
    // Check for /.../ pattern
    if (text[index] === '/') {
        let endIndex = index + 1;
        
        // Find the closing slash, handling escaped characters
        while (endIndex < text.length && text[endIndex] !== '/') {
            if (text[endIndex] === '\\' && endIndex + 1 < text.length) {
                endIndex += 2; // Skip escaped character
            } else {
                endIndex++;
            }
        }
        
        if (endIndex < text.length) {
            return {
                isRegex: true,
                endIndex: endIndex,
                pattern: text.substring(index, endIndex + 1)
            };
        }
    }
    
    return { isRegex: false, endIndex: index, pattern: '' };
}

// Simplified tokenization - now supports Korean text and regex patterns
// Let the client handle categorization based on its own logic
function tokenizeComplexText(text: string): Array<{ text: string; category: string }> {
    const tokens: Array<{ text: string; category: string }> = [];
    let i = 0;
    
    while (i < text.length) {
        const char = text[i];
        
        if (/\s/.test(char)) {
            // Whitespace - skip it (don't tokenize spaces in complex text)
            i++;
        } else {
            // Check if current position starts a regex pattern
            const regexCheck = isRegexStart(text, i);
            if (regexCheck.isRegex) {
                // Add the entire regex pattern as one token
                tokens.push({ text: regexCheck.pattern, category: 'regex_pattern' });
                i = regexCheck.endIndex + 1;
            } else if (/[a-zA-Z0-9]/.test(char)) {
                // English alphanumeric - collect as word
                let word = '';
                while (i < text.length && /[a-zA-Z0-9]/.test(text[i])) {
                    word += text[i];
                    i++;
                }
                if (word) {
                    tokens.push({ text: word, category: 'variable' });
                }
            } else if (isKoreanChar(char)) {
                // Korean characters - collect as word
                let koreanWord = '';
                while (i < text.length && isKoreanChar(text[i])) {
                    koreanWord += text[i];
                    i++;
                }
                if (koreanWord) {
                    tokens.push({ text: koreanWord, category: 'variable' });
                }
            } else {
                // All other characters (punctuation, symbols) - individual tokens
                tokens.push({ text: char, category: 'unknown' });
                i++;
            }
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
            // English alphanumeric - collect as word and use 'comment_text' category for comment voice
            let word = '';
            while (i < text.length && /[a-zA-Z0-9]/.test(text[i])) {
                word += text[i];
                i++;
            }
            if (word) {
                // Use 'comment_text' category so words are spoken with comment voice
                tokens.push({ text: word, category: 'comment_text' });
            }
        } else if (isKoreanChar(char)) {
            // Korean characters - collect as word and use 'comment_text' category for comment voice
            let koreanWord = '';
            while (i < text.length && isKoreanChar(text[i])) {
                koreanWord += text[i];
                i++;
            }
            if (koreanWord) {
                // Use 'comment_text' category so Korean words are spoken with comment voice
                tokens.push({ text: koreanWord, category: 'comment_text' });
            }
        } else {
            // Other characters - treat as symbols with 'comment_symbol' category
            tokens.push({ text: char, category: 'comment_symbol' });
            i++;
        }
    }
    
    return tokens;
}

// Helper function to tokenize comments - extract special chars but keep text as whole units
function tokenizeComment(commentText: string): Array<{ text: string; category: string }> {
    const tokens: Array<{ text: string; category: string }> = [];
    
    // Extract leading whitespace
    const leadingSpaceMatch = commentText.match(/^(\s*)/);
    if (leadingSpaceMatch && leadingSpaceMatch[1]) {
        tokens.push({ text: leadingSpaceMatch[1], category: 'whitespace' });
    }
    
    // Get the comment content without leading whitespace
    const trimmedComment = commentText.trim();
    
    if (trimmedComment) {
        // Parse the comment to extract special characters while keeping text together
        let i = 0;
        let currentText = '';
        
        while (i < trimmedComment.length) {
            const char = trimmedComment[i];
            const nextChar = trimmedComment[i + 1];
            
            // Check for comment symbols and other special characters
            if (char === '/' && nextChar === '/') {
                // Flush any accumulated text
                if (currentText.trim()) {
                    tokens.push({ text: currentText.trim(), category: 'comment_text' });
                    currentText = '';
                }
                tokens.push({ text: '//', category: 'comment_symbol' });
                i += 2;
            } else if (char === '#') {
                // Flush any accumulated text
                if (currentText.trim()) {
                    tokens.push({ text: currentText.trim(), category: 'comment_text' });
                    currentText = '';
                }
                tokens.push({ text: '#', category: 'comment_symbol' });
                i++;
            } else if (char === ':' || char === ';' || char === '.' || char === ',' || 
                       char === '(' || char === ')' || char === '[' || char === ']' || 
                       char === '{' || char === '}' || char === '"' || char === "'" || 
                       char === '`' || char === '_' || char === '\\') {
                // Flush any accumulated text
                if (currentText.trim()) {
                    tokens.push({ text: currentText.trim(), category: 'comment_text' });
                    currentText = '';
                }
                tokens.push({ text: char, category: 'comment_symbol' });
                i++;
            } else if (/\d/.test(char)) {
                // Numbers - collect consecutive digits
                let number = '';
                while (i < trimmedComment.length && /\d/.test(trimmedComment[i])) {
                    number += trimmedComment[i];
                    i++;
                }
                // Flush any accumulated text before the number
                if (currentText.trim()) {
                    tokens.push({ text: currentText.trim(), category: 'comment_text' });
                    currentText = '';
                }
                tokens.push({ text: number, category: 'comment_number' });
            } else if (/\s/.test(char)) {
                // Whitespace - add to current text but don't create separate tokens
                currentText += char;
                i++;
            } else {
                // Regular text character - accumulate
                currentText += char;
                i++;
            }
        }
        
        // Flush any remaining text
        if (currentText.trim()) {
            tokens.push({ text: currentText.trim(), category: 'comment_text' });
        }
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

// Python keywords list
const PYTHON_KEYWORDS = new Set([
    'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 
    'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 
    'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'match', 
    'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 
    'with', 'yield', 'self'  // Adding 'self' as it's a common Python convention
]);

// Helper function to check if a token is a Python keyword
function isPythonKeyword(token: string): boolean {
    return PYTHON_KEYWORDS.has(token);
}

// Helper function to scan code tokens using TypeScript scanner
function scanCodeTokens(codeText: string): Array<{ text: string; category: string }> {
    // Check for regex patterns first - if found, use complex tokenization
    if (codeText.includes("r'") || codeText.includes('r"') || /\/.*\/[gimuy]*/.test(codeText)) {
        return tokenizeComplexText(codeText);
    }
    
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
            // Check if this identifier is a Python keyword
            if (isPythonKeyword(tokenText)) {
                category = 'keyword';
            } else {
                category = 'variable';
            }
        } else if (kind === ts.SyntaxKind.StringLiteral || kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral) {
            // Separate quotes from string content 
            const stringContent = tokenText;
            
            // Add opening quote - let client decide categorization
            if (stringContent.startsWith('"') || stringContent.startsWith("'") || stringContent.startsWith('`')) {
                tokens.push({ text: stringContent[0], category: 'unknown' });
            }
            
            // Add string content (without quotes) - always treat as literal content
            const innerContent = stringContent.slice(1, -1); // Remove quotes
            if (innerContent) {
                // String content should always be treated as literal, regardless of complexity
                // This prevents tokens inside strings from being cached with wrong categories
                tokens.push({ text: innerContent, category: 'literal' });
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
