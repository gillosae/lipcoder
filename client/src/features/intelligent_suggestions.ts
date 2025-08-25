import * as path from 'path';
import * as vscode from 'vscode';
import { log } from '../utils';
import { speakTokenList } from '../audio';

// Interfaces for the suggestion system
export interface CodeSuggestion {
    title: string;
    description: string;
    explanation: string;
    instruction: string;
    category: string;
    priority: number;
}

export interface CodeAnalysis {
    hasClasses: boolean;
    hasFunctions: boolean;
    hasErrorHandling: boolean;
    hasTests: boolean;
    hasDocumentation: boolean;
    hasTypeAnnotations: boolean;
    hasAsyncCode: boolean;
    hasLogging: boolean;
    hasValidation: boolean;
    hasDatabase: boolean;
    hasAPI: boolean;
    hasUI: boolean;
    lineCount: number;
    language: string;
    fileName: string;
    complexity: number;
    // Enhanced fields for incomplete code detection
    notImplementedErrors: NotImplementedError[];
    todoComments: TodoComment[];
    placeholderCode: PlaceholderCode[];
    emptyFunctions: EmptyFunction[];
    stubMethods: StubMethod[];
}

export interface NotImplementedError {
    line: number;
    functionName: string;
    className?: string;
    context: string;
}

export interface TodoComment {
    line: number;
    text: string;
    priority: 'high' | 'medium' | 'low';
}

export interface PlaceholderCode {
    line: number;
    type: 'pass' | 'null' | 'undefined' | 'empty_return' | 'placeholder_comment';
    functionName: string;
    context: string;
}

export interface EmptyFunction {
    line: number;
    functionName: string;
    className?: string;
    parameters: string[];
}

export interface StubMethod {
    line: number;
    functionName: string;
    className?: string;
    returnType?: string;
}

/**
 * Generate intelligent, contextual suggestions based on code analysis
 */
export async function generateIntelligentSuggestions(
    code: string, 
    filePath: string, 
    getLanguageFromExtension: (ext: string) => string
): Promise<CodeSuggestion[]> {
    try {
        const fileName = path.basename(filePath);
        const fileExt = path.extname(filePath);
        const language = getLanguageFromExtension(fileExt);
        
        // Analyze the code content to understand what's there
        const codeAnalysis = await analyzeCodeForSuggestions(code, language, fileName);
        
        // Generate contextual suggestions based on analysis
        const suggestions: CodeSuggestion[] = [];
        
        // Add language-specific suggestions
        suggestions.push(...generateLanguageSpecificSuggestions(language, codeAnalysis));
        
        // PRIORITY: Add NotImplementedError and incomplete code suggestions first
        suggestions.push(...generateNotImplementedSuggestions(codeAnalysis));
        
        // Add feature-based suggestions
        suggestions.push(...generateFeatureSuggestions(codeAnalysis));
        
        // Add architecture suggestions
        suggestions.push(...generateArchitectureSuggestions(codeAnalysis));
        
        // Add testing suggestions
        suggestions.push(...generateTestingSuggestions(codeAnalysis, language));
        
        // Add documentation suggestions
        suggestions.push(...generateDocumentationSuggestions(codeAnalysis, language));
        
        // Sort by priority and return top suggestions
        return suggestions
            .sort((a, b) => b.priority - a.priority)
            .slice(0, 8); // Limit to 8 most relevant suggestions
            
    } catch (error) {
        log(`[Intelligent Suggestions] Error generating suggestions: ${error}`);
        return getBasicSuggestions();
    }
}

/**
 * Analyze code to understand its structure and identify improvement opportunities
 */
async function analyzeCodeForSuggestions(code: string, language: string, fileName: string): Promise<CodeAnalysis> {
    const analysis: CodeAnalysis = {
        hasClasses: /class\s+\w+/i.test(code),
        hasFunctions: /def\s+\w+|function\s+\w+|const\s+\w+\s*=|let\s+\w+\s*=/i.test(code),
        hasErrorHandling: /try\s*{|except|catch\s*\(|throw\s+/i.test(code),
        hasTests: /test|spec|describe|it\(/i.test(code),
        hasDocumentation: /\/\*\*|"""|'''|#\s*@|\/\/\s*@/i.test(code),
        hasTypeAnnotations: /:\s*\w+|<\w+>|\w+\[\]/i.test(code),
        hasAsyncCode: /async|await|Promise|callback/i.test(code),
        hasLogging: /console\.|print\(|log\(|logger\./i.test(code),
        hasValidation: /validate|check|verify|assert/i.test(code),
        hasDatabase: /sql|query|database|db\.|collection/i.test(code),
        hasAPI: /api|endpoint|route|request|response/i.test(code),
        hasUI: /component|render|jsx|html|css/i.test(code),
        lineCount: code.split('\n').length,
        language,
        fileName,
        complexity: calculateComplexity(code),
        // Enhanced analysis for incomplete code patterns
        notImplementedErrors: findNotImplementedErrors(code),
        todoComments: findTodoComments(code),
        placeholderCode: findPlaceholderCode(code),
        emptyFunctions: findEmptyFunctions(code),
        stubMethods: findStubMethods(code)
    };
    
    return analysis;
}

/**
 * Generate suggestions focused on NotImplementedError and incomplete code (HIGHEST PRIORITY)
 */
function generateNotImplementedSuggestions(analysis: CodeAnalysis): CodeSuggestion[] {
    const suggestions: CodeSuggestion[] = [];
    
    // Handle NotImplementedError instances
    if (analysis.notImplementedErrors.length > 0) {
        const errorCount = analysis.notImplementedErrors.length;
        const functionNames = analysis.notImplementedErrors.map(e => e.functionName).join(', ');
        
        suggestions.push({
            title: `🚨 Implement ${errorCount} Missing Function${errorCount > 1 ? 's' : ''}`,
            description: `Complete implementation for: ${functionNames}`,
            explanation: `You have ${errorCount} function${errorCount > 1 ? 's' : ''} that currently raise NotImplementedError. These are placeholders waiting for actual implementation. Implementing these functions will make your code functional and complete.`,
            instruction: `Implement the actual functionality for these functions that currently raise NotImplementedError: ${functionNames}. Replace the NotImplementedError with proper business logic, including parameter validation, core functionality, and appropriate return values.`,
            category: 'critical_implementation',
            priority: 10 // HIGHEST PRIORITY
        });
    }
    
    // Handle empty functions
    if (analysis.emptyFunctions.length > 0) {
        const emptyCount = analysis.emptyFunctions.length;
        const emptyNames = analysis.emptyFunctions.map(f => f.functionName).join(', ');
        
        suggestions.push({
            title: `⚠️ Complete ${emptyCount} Empty Function${emptyCount > 1 ? 's' : ''}`,
            description: `Add implementation to: ${emptyNames}`,
            explanation: `You have ${emptyCount} function${emptyCount > 1 ? 's' : ''} that are empty or only contain placeholder code. These functions need proper implementation to be useful.`,
            instruction: `Add meaningful implementation to these empty functions: ${emptyNames}. Include parameter validation, core logic, error handling, and appropriate return values based on the function's intended purpose.`,
            category: 'implementation',
            priority: 9
        });
    }
    
    // Handle stub methods
    if (analysis.stubMethods.length > 0) {
        const stubCount = analysis.stubMethods.length;
        const stubNames = analysis.stubMethods.map(s => s.functionName).join(', ');
        
        suggestions.push({
            title: `🔧 Implement ${stubCount} Stub Method${stubCount > 1 ? 's' : ''}`,
            description: `Replace stubs with real implementation: ${stubNames}`,
            explanation: `You have ${stubCount} method${stubCount > 1 ? 's' : ''} that are currently just stubs. These need to be replaced with actual working implementations.`,
            instruction: `Replace the stub implementations in these methods with real functionality: ${stubNames}. Remove the NotImplementedError and add proper business logic, validation, and return appropriate values.`,
            category: 'stub_implementation',
            priority: 9
        });
    }
    
    // Handle placeholder code
    if (analysis.placeholderCode.length > 0) {
        const placeholderCount = analysis.placeholderCode.length;
        const placeholderTypes = [...new Set(analysis.placeholderCode.map(p => p.type))];
        
        suggestions.push({
            title: `📝 Replace ${placeholderCount} Placeholder${placeholderCount > 1 ? 's' : ''}`,
            description: `Complete placeholder code (${placeholderTypes.join(', ')})`,
            explanation: `You have ${placeholderCount} placeholder${placeholderCount > 1 ? 's' : ''} in your code including ${placeholderTypes.join(', ')}. These need to be replaced with actual implementation.`,
            instruction: `Replace all placeholder code including 'pass' statements, empty returns, and placeholder comments with proper implementation. Add meaningful logic, validation, and return appropriate values.`,
            category: 'placeholder_completion',
            priority: 8
        });
    }
    
    // Handle high-priority TODO comments
    const highPriorityTodos = analysis.todoComments.filter(t => t.priority === 'high');
    if (highPriorityTodos.length > 0) {
        const todoCount = highPriorityTodos.length;
        const todoTexts = highPriorityTodos.map(t => t.text).join('; ');
        
        suggestions.push({
            title: `🔥 Address ${todoCount} Critical TODO${todoCount > 1 ? 's' : ''}`,
            description: `Fix urgent issues: ${todoTexts.substring(0, 100)}${todoTexts.length > 100 ? '...' : ''}`,
            explanation: `You have ${todoCount} high-priority TODO comment${todoCount > 1 ? 's' : ''} marked as FIXME, BUG, HACK, or XXX. These indicate critical issues that need immediate attention.`,
            instruction: `Address these critical TODO items: ${todoTexts}. Fix bugs, remove hacks, and implement proper solutions for these urgent issues.`,
            category: 'critical_todos',
            priority: 9
        });
    }
    
    // Handle medium-priority TODOs if there are many
    const mediumTodos = analysis.todoComments.filter(t => t.priority === 'medium');
    if (mediumTodos.length >= 3) {
        suggestions.push({
            title: `📋 Complete ${mediumTodos.length} TODO Items`,
            description: `Finish pending tasks and improvements`,
            explanation: `You have ${mediumTodos.length} TODO items that represent planned improvements or features. Completing these will enhance your code's functionality and quality.`,
            instruction: `Complete the pending TODO items in your code. Review each TODO comment and implement the requested features, improvements, or fixes.`,
            category: 'todo_completion',
            priority: 6
        });
    }
    
    return suggestions;
}

/**
 * Generate language-specific suggestions
 */
function generateLanguageSpecificSuggestions(language: string, analysis: CodeAnalysis): CodeSuggestion[] {
    const suggestions: CodeSuggestion[] = [];
    
    switch (language.toLowerCase()) {
        case 'python':
            if (!analysis.hasTypeAnnotations) {
                suggestions.push({
                    title: 'Add Type Hints',
                    description: 'Improve code clarity and IDE support',
                    explanation: 'Type hints make your Python code more readable and help catch errors early. They also enable better IDE autocompletion and static analysis.',
                    instruction: 'Add comprehensive type hints to all functions, method parameters, and return values in this Python code',
                    category: 'type_safety',
                    priority: 8
                });
            }
            if (!analysis.hasDocumentation) {
                suggestions.push({
                    title: 'Add Docstrings',
                    description: 'Document functions with Python docstrings',
                    explanation: 'Docstrings provide clear documentation for your functions and classes, making your code more maintainable and helping other developers understand your API.',
                    instruction: 'Add comprehensive docstrings to all classes and functions following Python PEP 257 conventions',
                    category: 'documentation',
                    priority: 7
                });
            }
            if (analysis.hasClasses && !analysis.hasValidation) {
                suggestions.push({
                    title: 'Add Property Validation',
                    description: 'Validate class properties and method inputs',
                    explanation: 'Property validation ensures data integrity and prevents invalid states in your objects.',
                    instruction: 'Add property validation using Python properties, setters, and input validation for all class methods',
                    category: 'validation',
                    priority: 7
                });
            }
            break;
            
        case 'typescript':
        case 'javascript':
            if (!analysis.hasTypeAnnotations && language === 'typescript') {
                suggestions.push({
                    title: 'Strengthen Type Safety',
                    description: 'Add strict TypeScript types',
                    explanation: 'Strong typing prevents runtime errors and improves code maintainability. It also enables better refactoring and IDE support.',
                    instruction: 'Add strict TypeScript interfaces, types, and generic constraints to improve type safety',
                    category: 'type_safety',
                    priority: 8
                });
            }
            if (!analysis.hasErrorHandling && analysis.hasAsyncCode) {
                suggestions.push({
                    title: 'Add Async Error Handling',
                    description: 'Handle Promise rejections properly',
                    explanation: 'Proper async error handling prevents unhandled promise rejections and makes your application more robust.',
                    instruction: 'Add comprehensive error handling for all async operations using try-catch blocks and proper error propagation',
                    category: 'error_handling',
                    priority: 9
                });
            }
            if (analysis.hasUI && !analysis.hasValidation) {
                suggestions.push({
                    title: 'Add Form Validation',
                    description: 'Implement client-side form validation',
                    explanation: 'Form validation improves user experience by providing immediate feedback and prevents invalid data submission.',
                    instruction: 'Add comprehensive form validation with real-time feedback, error messages, and input sanitization',
                    category: 'ui',
                    priority: 7
                });
            }
            break;
            
        case 'java':
            if (!analysis.hasErrorHandling) {
                suggestions.push({
                    title: 'Add Exception Handling',
                    description: 'Implement proper Java exception handling',
                    explanation: 'Java exception handling ensures your application can gracefully handle errors and provide meaningful feedback.',
                    instruction: 'Add try-catch blocks, custom exceptions, and proper exception propagation following Java best practices',
                    category: 'error_handling',
                    priority: 8
                });
            }
            if (analysis.hasClasses && !analysis.hasDocumentation) {
                suggestions.push({
                    title: 'Add JavaDoc Comments',
                    description: 'Document classes and methods with JavaDoc',
                    explanation: 'JavaDoc comments provide standardized documentation that can be automatically generated into API documentation.',
                    instruction: 'Add comprehensive JavaDoc comments to all public classes, methods, and fields',
                    category: 'documentation',
                    priority: 6
                });
            }
            break;
    }
    
    return suggestions;
}

/**
 * Generate feature-based suggestions
 */
function generateFeatureSuggestions(analysis: CodeAnalysis): CodeSuggestion[] {
    const suggestions: CodeSuggestion[] = [];
    
    if (!analysis.hasErrorHandling) {
        suggestions.push({
            title: 'Implement Error Handling',
            description: 'Add robust error handling and recovery',
            explanation: 'Proper error handling makes your application more reliable by gracefully handling unexpected situations and providing meaningful feedback to users.',
            instruction: 'Add comprehensive error handling with try-catch blocks, input validation, and user-friendly error messages',
            category: 'reliability',
            priority: 9
        });
    }
    
    if (!analysis.hasLogging) {
        suggestions.push({
            title: 'Add Logging System',
            description: 'Implement structured logging for debugging',
            explanation: 'Logging helps you track application behavior, debug issues, and monitor performance in production environments.',
            instruction: 'Implement a structured logging system with different log levels (debug, info, warn, error) and meaningful log messages',
            category: 'observability',
            priority: 7
        });
    }
    
    if (!analysis.hasValidation && (analysis.hasFunctions || analysis.hasAPI)) {
        suggestions.push({
            title: 'Add Input Validation',
            description: 'Validate and sanitize user inputs',
            explanation: 'Input validation prevents security vulnerabilities and ensures data integrity by checking that inputs meet expected formats and constraints.',
            instruction: 'Add comprehensive input validation with parameter checking, data sanitization, and meaningful validation error messages',
            category: 'security',
            priority: 8
        });
    }
    
    if (analysis.hasDatabase && !analysis.hasErrorHandling) {
        suggestions.push({
            title: 'Add Database Error Handling',
            description: 'Handle database connection and query errors',
            explanation: 'Database operations can fail due to network issues, constraint violations, or connection problems. Proper error handling ensures your application remains stable.',
            instruction: 'Add database-specific error handling including connection timeouts, transaction rollbacks, and query error recovery',
            category: 'database',
            priority: 8
        });
    }
    
    if (analysis.hasAPI && !analysis.hasValidation) {
        suggestions.push({
            title: 'Add API Authentication',
            description: 'Implement secure API authentication',
            explanation: 'API authentication protects your endpoints from unauthorized access and ensures only legitimate users can access your data.',
            instruction: 'Implement API authentication using JWT tokens, API keys, or OAuth with proper authorization middleware',
            category: 'security',
            priority: 8
        });
    }
    
    if (analysis.hasClasses && analysis.lineCount > 100) {
        suggestions.push({
            title: 'Add Configuration Management',
            description: 'Externalize configuration settings',
            explanation: 'Configuration management makes your application more flexible and easier to deploy across different environments.',
            instruction: 'Extract hardcoded values into configuration files with environment-specific settings and validation',
            category: 'configuration',
            priority: 6
        });
    }
    
    return suggestions;
}

/**
 * Generate architecture suggestions
 */
function generateArchitectureSuggestions(analysis: CodeAnalysis): CodeSuggestion[] {
    const suggestions: CodeSuggestion[] = [];
    
    if (analysis.complexity > 10) {
        suggestions.push({
            title: 'Refactor Complex Code',
            description: 'Break down complex functions into smaller parts',
            explanation: 'Complex functions are harder to understand, test, and maintain. Breaking them into smaller, focused functions improves code readability and reusability.',
            instruction: 'Refactor complex functions by extracting smaller, single-purpose functions and reducing cyclomatic complexity',
            category: 'architecture',
            priority: 7
        });
    }
    
    if (analysis.hasClasses && analysis.lineCount > 200) {
        suggestions.push({
            title: 'Apply SOLID Principles',
            description: 'Improve class design with SOLID principles',
            explanation: 'SOLID principles make your code more modular, testable, and maintainable by ensuring single responsibility, open/closed design, and proper dependency management.',
            instruction: 'Refactor classes to follow SOLID principles: single responsibility, open/closed, Liskov substitution, interface segregation, and dependency inversion',
            category: 'architecture',
            priority: 6
        });
    }
    
    if (analysis.hasAPI && !analysis.hasValidation) {
        suggestions.push({
            title: 'Add API Rate Limiting',
            description: 'Implement rate limiting and throttling',
            explanation: 'Rate limiting protects your API from abuse and ensures fair usage by limiting the number of requests per user or IP address.',
            instruction: 'Implement API rate limiting with configurable limits, proper HTTP status codes, and retry-after headers',
            category: 'api',
            priority: 6
        });
    }
    
    if (analysis.hasFunctions && analysis.lineCount > 150) {
        suggestions.push({
            title: 'Add Caching Layer',
            description: 'Implement intelligent caching for performance',
            explanation: 'Caching improves application performance by storing frequently accessed data in memory, reducing database queries and computation time.',
            instruction: 'Add a caching layer with TTL, cache invalidation, and memory management for frequently accessed data',
            category: 'performance',
            priority: 6
        });
    }
    
    return suggestions;
}

/**
 * Generate testing suggestions
 */
function generateTestingSuggestions(analysis: CodeAnalysis, language: string): CodeSuggestion[] {
    const suggestions: CodeSuggestion[] = [];
    
    if (!analysis.hasTests) {
        const testFramework = getTestFrameworkForLanguage(language);
        suggestions.push({
            title: 'Create Unit Tests',
            description: `Add comprehensive unit tests using ${testFramework}`,
            explanation: 'Unit tests ensure your code works correctly and help prevent regressions when making changes. They also serve as documentation for expected behavior.',
            instruction: `Create comprehensive unit tests using ${testFramework} framework, covering all public methods, edge cases, and error conditions`,
            category: 'testing',
            priority: 8
        });
    }
    
    if (analysis.hasAPI && !analysis.hasTests) {
        suggestions.push({
            title: 'Add Integration Tests',
            description: 'Test API endpoints and data flow',
            explanation: 'Integration tests verify that different parts of your application work together correctly, especially important for API endpoints and database interactions.',
            instruction: 'Create integration tests for API endpoints, testing request/response cycles, authentication, and data persistence',
            category: 'testing',
            priority: 7
        });
    }
    
    if (analysis.hasDatabase && !analysis.hasTests) {
        suggestions.push({
            title: 'Add Database Tests',
            description: 'Test database operations and migrations',
            explanation: 'Database tests ensure your data layer works correctly and that schema changes don\'t break existing functionality.',
            instruction: 'Create database tests covering CRUD operations, constraints, migrations, and data integrity',
            category: 'testing',
            priority: 7
        });
    }
    
    return suggestions;
}

/**
 * Generate documentation suggestions
 */
function generateDocumentationSuggestions(analysis: CodeAnalysis, language: string): CodeSuggestion[] {
    const suggestions: CodeSuggestion[] = [];
    
    if (!analysis.hasDocumentation) {
        suggestions.push({
            title: 'Add Code Documentation',
            description: 'Document classes, functions, and complex logic',
            explanation: 'Good documentation makes your code easier to understand and maintain. It helps other developers (and future you) understand the purpose and usage of your code.',
            instruction: 'Add comprehensive documentation including function descriptions, parameter explanations, return value descriptions, and usage examples',
            category: 'documentation',
            priority: 6
        });
    }
    
    if (analysis.hasAPI) {
        suggestions.push({
            title: 'Generate API Documentation',
            description: 'Create interactive API documentation',
            explanation: 'API documentation helps developers understand how to use your endpoints, including request/response formats, authentication requirements, and error codes.',
            instruction: 'Generate comprehensive API documentation with endpoint descriptions, request/response schemas, authentication details, and usage examples',
            category: 'documentation',
            priority: 7
        });
    }
    
    if (analysis.hasClasses && !analysis.hasDocumentation) {
        suggestions.push({
            title: 'Add Architecture Documentation',
            description: 'Document system architecture and design decisions',
            explanation: 'Architecture documentation helps developers understand the overall system design, component relationships, and design rationale.',
            instruction: 'Create architecture documentation including system overview, component diagrams, design patterns used, and architectural decision records',
            category: 'documentation',
            priority: 5
        });
    }
    
    return suggestions;
}

/**
 * Find NotImplementedError instances in code
 */
function findNotImplementedErrors(code: string): NotImplementedError[] {
    const errors: NotImplementedError[] = [];
    const lines = code.split('\n');
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNumber = i + 1;
        
        // Python NotImplementedError patterns
        if (/raise\s+NotImplementedError|NotImplementedError\(/i.test(line)) {
            const functionMatch = findFunctionContext(lines, i);
            errors.push({
                line: lineNumber,
                functionName: functionMatch.functionName || 'unknown',
                className: functionMatch.className,
                context: line.trim()
            });
        }
        
        // JavaScript/TypeScript throw new Error patterns
        if (/throw\s+new\s+Error\s*\(\s*['"](not\s+implemented|todo|placeholder)/i.test(line)) {
            const functionMatch = findFunctionContext(lines, i);
            errors.push({
                line: lineNumber,
                functionName: functionMatch.functionName || 'unknown',
                className: functionMatch.className,
                context: line.trim()
            });
        }
    }
    
    return errors;
}

/**
 * Find TODO comments in code
 */
function findTodoComments(code: string): TodoComment[] {
    const todos: TodoComment[] = [];
    const lines = code.split('\n');
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNumber = i + 1;
        
        // Match TODO, FIXME, HACK, XXX comments
        const todoMatch = line.match(/(\/\/|#|\*)\s*(TODO|FIXME|HACK|XXX|BUG)[\s:]*(.+)/i);
        if (todoMatch) {
            const keyword = todoMatch[2].toUpperCase();
            const text = todoMatch[3] || '';
            
            let priority: 'high' | 'medium' | 'low' = 'medium';
            if (keyword === 'FIXME' || keyword === 'BUG') priority = 'high';
            if (keyword === 'HACK' || keyword === 'XXX') priority = 'high';
            if (keyword === 'TODO') priority = 'medium';
            
            todos.push({
                line: lineNumber,
                text: text.trim(),
                priority
            });
        }
    }
    
    return todos;
}

/**
 * Find placeholder code patterns
 */
function findPlaceholderCode(code: string): PlaceholderCode[] {
    const placeholders: PlaceholderCode[] = [];
    const lines = code.split('\n');
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        const lineNumber = i + 1;
        
        if (!line) continue;
        
        const functionMatch = findFunctionContext(lines, i);
        
        // Python pass statements
        if (line === 'pass') {
            placeholders.push({
                line: lineNumber,
                type: 'pass',
                functionName: functionMatch.functionName || 'unknown',
                context: line
            });
        }
        
        // Return null/undefined/None
        if (/^return\s+(null|undefined|None)\s*;?$/.test(line)) {
            placeholders.push({
                line: lineNumber,
                type: 'null',
                functionName: functionMatch.functionName || 'unknown',
                context: line
            });
        }
        
        // Empty return statements
        if (/^return\s*;?$/.test(line)) {
            placeholders.push({
                line: lineNumber,
                type: 'empty_return',
                functionName: functionMatch.functionName || 'unknown',
                context: line
            });
        }
        
        // Placeholder comments
        if (/(\/\/|#)\s*(placeholder|implement|fill|complete)/i.test(line)) {
            placeholders.push({
                line: lineNumber,
                type: 'placeholder_comment',
                functionName: functionMatch.functionName || 'unknown',
                context: line
            });
        }
    }
    
    return placeholders;
}

/**
 * Find empty functions (functions with no meaningful implementation)
 */
function findEmptyFunctions(code: string): EmptyFunction[] {
    const emptyFunctions: EmptyFunction[] = [];
    const lines = code.split('\n');
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        // Match function definitions
        const functionMatch = line.match(/(def\s+(\w+)|function\s+(\w+)|(\w+)\s*\(.*\)\s*{)/);
        if (functionMatch) {
            const functionName = functionMatch[2] || functionMatch[3] || functionMatch[4];
            const parameters = extractParameters(line);
            
            // Check if function is empty or only contains pass/return null
            const functionBody = extractFunctionBody(lines, i);
            const meaningfulLines = functionBody.filter(bodyLine => {
                const trimmed = bodyLine.trim();
                return trimmed && 
                       trimmed !== 'pass' && 
                       !trimmed.startsWith('//') && 
                       !trimmed.startsWith('#') &&
                       !/^return\s*(null|undefined|None)?\s*;?$/.test(trimmed);
            });
            
            if (meaningfulLines.length === 0) {
                emptyFunctions.push({
                    line: i + 1,
                    functionName,
                    parameters
                });
            }
        }
    }
    
    return emptyFunctions;
}

/**
 * Find stub methods (methods that only throw NotImplementedError or similar)
 */
function findStubMethods(code: string): StubMethod[] {
    const stubs: StubMethod[] = [];
    const lines = code.split('\n');
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        // Match method definitions
        const methodMatch = line.match(/(def\s+(\w+)|(\w+)\s*\(.*\)\s*:\s*(\w+)?)/);
        if (methodMatch) {
            const functionName = methodMatch[2] || methodMatch[3];
            const returnType = methodMatch[4];
            
            // Check if method only contains NotImplementedError or similar
            const functionBody = extractFunctionBody(lines, i);
            const hasOnlyStub = functionBody.some(bodyLine => 
                /raise\s+NotImplementedError|throw\s+new\s+Error.*not\s+implemented/i.test(bodyLine)
            ) && functionBody.filter(bodyLine => bodyLine.trim() && !bodyLine.trim().startsWith('#')).length <= 2;
            
            if (hasOnlyStub) {
                stubs.push({
                    line: i + 1,
                    functionName,
                    returnType
                });
            }
        }
    }
    
    return stubs;
}

/**
 * Find function context for a given line
 */
function findFunctionContext(lines: string[], currentLine: number): { functionName?: string; className?: string } {
    // Look backwards to find the containing function/class
    for (let i = currentLine; i >= 0; i--) {
        const line = lines[i];
        
        // Match function definitions
        const functionMatch = line.match(/^\s*(def\s+(\w+)|function\s+(\w+)|(\w+)\s*\()/);
        if (functionMatch) {
            return { functionName: functionMatch[2] || functionMatch[3] || functionMatch[4] };
        }
        
        // Match class definitions
        const classMatch = line.match(/^\s*class\s+(\w+)/);
        if (classMatch) {
            return { className: classMatch[1] };
        }
    }
    
    return {};
}

/**
 * Extract parameters from function definition
 */
function extractParameters(functionLine: string): string[] {
    const paramMatch = functionLine.match(/\(([^)]*)\)/);
    if (!paramMatch) return [];
    
    return paramMatch[1]
        .split(',')
        .map(param => param.trim())
        .filter(param => param && param !== 'self');
}

/**
 * Extract function body lines
 */
function extractFunctionBody(lines: string[], startLine: number): string[] {
    const body: string[] = [];
    const functionIndent = lines[startLine].match(/^(\s*)/)?.[1]?.length || 0;
    
    for (let i = startLine + 1; i < lines.length; i++) {
        const line = lines[i];
        const lineIndent = line.match(/^(\s*)/)?.[1]?.length || 0;
        
        // Stop if we've reached the same or lower indentation level (end of function)
        if (line.trim() && lineIndent <= functionIndent) {
            break;
        }
        
        body.push(line);
    }
    
    return body;
}

/**
 * Calculate code complexity (simplified metric)
 */
function calculateComplexity(code: string): number {
    const complexityIndicators = [
        /if\s*\(/g,
        /else\s*if/g,
        /for\s*\(/g,
        /while\s*\(/g,
        /switch\s*\(/g,
        /catch\s*\(/g,
        /&&|\|\|/g
    ];
    
    let complexity = 1; // Base complexity
    for (const pattern of complexityIndicators) {
        const matches = code.match(pattern);
        if (matches) {
            complexity += matches.length;
        }
    }
    
    return complexity;
}

/**
 * Get test framework for language
 */
function getTestFrameworkForLanguage(language: string): string {
    const frameworks: { [key: string]: string } = {
        'python': 'pytest',
        'javascript': 'Jest',
        'typescript': 'Jest',
        'java': 'JUnit',
        'csharp': 'NUnit',
        'go': 'Go testing',
        'rust': 'Rust test'
    };
    
    return frameworks[language.toLowerCase()] || 'appropriate testing framework';
}

/**
 * Fallback basic suggestions
 */
function getBasicSuggestions(): CodeSuggestion[] {
    return [
        {
            title: 'Add Error Handling',
            description: 'Implement robust error handling',
            explanation: 'Error handling makes your code more reliable and user-friendly by gracefully handling unexpected situations.',
            instruction: 'Add comprehensive error handling with try-catch blocks and meaningful error messages',
            category: 'reliability',
            priority: 8
        },
        {
            title: 'Add Unit Tests',
            description: 'Create comprehensive test coverage',
            explanation: 'Tests ensure your code works correctly and prevent regressions when making changes.',
            instruction: 'Create unit tests covering all functions and edge cases',
            category: 'testing',
            priority: 7
        },
        {
            title: 'Add Input Validation',
            description: 'Validate and sanitize inputs',
            explanation: 'Input validation prevents security vulnerabilities and ensures data integrity.',
            instruction: 'Add input validation with parameter checking and sanitization',
            category: 'security',
            priority: 7
        }
    ];
}

/**
 * Show intelligent suggestions with rich UI
 */
export async function showIntelligentSuggestions(
    code: string, 
    filePath: string, 
    getLanguageFromExtension: (ext: string) => string,
    executeCallback: (instruction: string) => Promise<void>
): Promise<void> {
    try {
        // Generate intelligent suggestions
        const suggestions = await generateIntelligentSuggestions(code, filePath, getLanguageFromExtension);
        
        if (suggestions.length === 0) {
            log('[Intelligent Suggestions] No suggestions generated');
            return;
        }
        
        // Create rich suggestion items with descriptions
        const suggestionItems = suggestions.map(suggestion => ({
            label: `🚀 ${suggestion.title}`,
            description: suggestion.description,
            detail: suggestion.explanation,
            instruction: suggestion.instruction,
            category: suggestion.category
        }));
        
        const choice = await vscode.window.showQuickPick(suggestionItems, {
            placeHolder: 'What feature would you like to implement next?',
            title: 'Smart Code Enhancement Suggestions',
            matchOnDescription: true,
            matchOnDetail: true
        });
        
        if (choice) {
            log(`[Intelligent Suggestions] User selected: ${choice.label} - ${choice.instruction}`);
            
            // Speak the selection with explanation
            await speakTokenList([{
                tokens: [`Selected: ${choice.label.replace('🚀 ', '')}. ${choice.detail}`],
                category: undefined
            }]);
            
            // Show confirmation with detailed explanation
            const shouldContinue = await vscode.window.showInformationMessage(
                `Implement: ${choice.label.replace('🚀 ', '')}?\n\n${choice.detail}`,
                { modal: true },
                'Yes, implement it',
                'No, skip'
            );
            
            if (shouldContinue === 'Yes, implement it') {
                // Execute the callback with the detailed instruction
                await executeCallback(choice.instruction);
            }
        }
    } catch (error) {
        log(`[Intelligent Suggestions] Error in suggestion popup: ${error}`);
        // Fallback to basic suggestions
        await showBasicSuggestions(executeCallback);
    }
}

/**
 * Show basic suggestions as fallback
 */
async function showBasicSuggestions(executeCallback: (instruction: string) => Promise<void>): Promise<void> {
    const basicSuggestions = [
        'Add comprehensive error handling',
        'Create unit tests with good coverage',
        'Add input validation and sanitization',
        'Implement logging for debugging'
    ];
    
    const choice = await vscode.window.showQuickPick(basicSuggestions, {
        placeHolder: 'What would you like to do next?',
        title: 'Code Improvement Suggestions'
    });
    
    if (choice) {
        await executeCallback(choice);
    }
}
