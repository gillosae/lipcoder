import * as path from 'path';
import type { ExtensionContext } from 'vscode';

let extRoot: string | undefined;

// Initialize config with the extension's root path.
export function initConfig(context: ExtensionContext) {
    extRoot = context.extensionPath;
}

// Helper function to safely get extRoot
function getExtRoot(): string {
    if (!extRoot) {
        throw new Error('Extension root not initialized. Call initConfig() first.');
    }
    return extRoot;
}

// Safe helper function that returns empty string if not initialized (for early calls)
function safeGetExtRoot(): string {
    return extRoot || '';
}

// TTS Backends & Config ─────────────────────────────────────────────────────
export enum TTSBackend {
    SileroGPT = 'silero-gpt',     // Silero for English + GPT for Korean
    EspeakGPT = 'espeak-gpt',     // Espeak for English + GPT for Korean  
    Espeak = 'espeak',           // Espeak for all languages (including Korean)
    XTTSV2 = 'xtts-v2',          // XTTS-v2 for both Korean and English
    MacOSGPT = 'macos-gpt',      // macOS native voice for English + GPT for Korean
    MacOS = 'macos',             // macOS native voice for all languages
}

// ASR Backends & Config ─────────────────────────────────────────────────────
export enum ASRBackend {
    Silero = 'silero',
    GPT4o = 'gpt4o-transcribe',
    HuggingFaceWhisper = 'huggingface-whisper',
}

// LLM Backends & Config ─────────────────────────────────────────────────────
export enum LLMBackend {
    ChatGPT = 'chatgpt',
    Claude = 'claude',
}

export interface SileroASRConfig {
    serverUrl: string;
    sampleRate: number;
    chunkDuration: number;
}

export interface GPT4oASRConfig {
    apiKey: string;
    model: string; // Whisper model (whisper-1)
    language?: string | null; // null for auto-detection, string for specific language
    sampleRate: number;
    temperature?: number;
}

export interface HuggingFaceWhisperConfig {
    serverUrl: string;
    model: string; // Whisper model (e.g., openai/whisper-large-v3)
    language?: string | null; // null for auto-detection, string for specific language
    sampleRate: number;
    chunkDuration: number; // milliseconds
}

export interface SileroConfig {
    pythonPath: string;
    scriptPath: string;
    language: string;
    modelId: string;
    defaultSpeaker?: string;
    sampleRate: number;
}

export interface EspeakConfig {
    language: string;
    defaultVoice: string;
    speed: number;        // words per minute (default: 175)
    pitch: number;        // 0-99 (default: 50)
    amplitude: number;    // 0-200 (default: 100)
    gap: number;          // gap between words in 10ms units
    sampleRate: number;   // output sample rate
}

export interface OpenAITTSConfig {
    apiKey: string;
    model: string;        // tts-1 or tts-1-hd
    voice: string;        // alloy, echo, fable, onyx, nova, shimmer
    language: string;     // ko for Korean, en for English, etc.
    speed: number;        // 0.25 to 4.0 (default: 1.0)
    responseFormat: string; // mp3, opus, aac, flac, wav, pcm
    volumeBoost: number;  // Volume boost multiplier (1.0 = no change, 1.5 = 50% louder)
}

export interface XTTSV2Config {
    serverUrl: string;    // URL of the XTTS-v2 server
    model: string;        // tts_models/multilingual/multi-dataset/xtts_v2
    language: string;     // ko for Korean
    sampleRate: number;   // 24000 (XTTS-v2 default)
    volumeBoost: number;  // Volume boost multiplier
    speakerWav?: string;  // Optional speaker reference for voice cloning
}

export interface MacOSConfig {
    language: string;     // en for English
    defaultVoice: string; // Alex, Samantha, Victoria, etc.
    rate: number;         // words per minute (default: 200)
    volume: number;       // 0.0-1.0 (default: 0.7)
    sampleRate: number;   // output sample rate
}

export interface ClaudeConfig {
    apiKey: string;
    model: string;        // claude-3-5-sonnet-20241022, claude-3-haiku-20240307, etc.
    maxTokens: number;    // maximum tokens for response
    temperature: number;  // 0.0 to 1.0 (default: 0.1 for code)
}

export interface VibeCodingConfig {
    showPopups: boolean;
}

export let currentBackend = TTSBackend.MacOS; // Changed from XTTS to MacOS for stability

// ASR Configuration ─────────────────────────────────────────────────────
export let currentASRBackend = ASRBackend.HuggingFaceWhisper; // Use Hugging Face Whisper with VAD for better accuracy

// LLM Configuration ─────────────────────────────────────────────────────
export let currentLLMBackend = LLMBackend.Claude; // Claude for vibe coding, ChatGPT used directly for routing

export let sileroASRConfig: SileroASRConfig = {
    serverUrl: 'http://localhost:5004/asr',
    sampleRate: 16000,
    chunkDuration: 2000, // 2 seconds
};

export let gpt4oASRConfig: GPT4oASRConfig = {
    apiKey: '', // Will be loaded from VS Code settings
    model: 'whisper-1', // Using Whisper for reliable transcription
    language: 'ko', // Force Korean to prevent Japanese hallucinations
    sampleRate: 16000, // Whisper prefers 16kHz
    temperature: 0.0, // Maximum anti-hallucination setting
};

export let huggingFaceWhisperConfig: HuggingFaceWhisperConfig = {
    serverUrl: 'http://localhost:5005/asr', // Local Hugging Face Whisper server
    model: 'openai/whisper-small', // Small model for faster loading and good accuracy
    language: 'ko', // Korean language for better recognition
    sampleRate: 16000, // Whisper prefers 16kHz
    chunkDuration: 2000, // 2 seconds chunks
};

export let sileroConfig: SileroConfig = {
    pythonPath: '',
    scriptPath: '',
    language: 'en',
    modelId: 'v3_en',
    defaultSpeaker: 'en_3',
    sampleRate: 24000,
};

export let espeakConfig: EspeakConfig = {
    language: 'en',
    defaultVoice: 'en-us',  // Use valid espeak-ng voice name
    speed: 220,  // Increased from 175 for faster speech
    pitch: 50,
    amplitude: 100,
    gap: 0,  // No gap between words
    sampleRate: 24000,
};

export let openaiTTSConfig: OpenAITTSConfig = {
    apiKey: '', // Will be loaded from VS Code settings
    model: 'tts-1', // Use standard model by default
    voice: 'alloy', // Default voice
    language: 'ko', // Korean language
    speed: 1.0, // Normal speed
    responseFormat: 'wav', // WAV format for compatibility
    volumeBoost: 1.3, // 30% volume boost for Korean TTS
};

export let xttsV2Config: XTTSV2Config = {
    serverUrl: 'http://localhost:5006/tts_fast', // Use fast endpoint with precomputed embeddings
    model: 'tts_models/multilingual/multi-dataset/xtts_v2', // XTTS-v2 model
    language: 'ko', // Korean language
    sampleRate: 24000, // 24kHz (XTTS-v2 default)
    volumeBoost: 1.0, // No volume boost by default
};

export let macosConfig: MacOSConfig = {
    language: 'en',
    defaultVoice: 'Yuna',  // Default macOS voice (Yuna supports Korean)
    rate: 200,  // words per minute
    volume: 0.7,  // volume level (0.0-1.0)
    sampleRate: 24000,
};

export let claudeConfig: ClaudeConfig = {
    apiKey: '', // Will be loaded from VS Code settings
    model: 'claude-sonnet-4-20250514', // Latest Sonnet model
    maxTokens: 2000, // Max tokens for code modifications
    temperature: 0.1, // Low temperature for consistent code generation
};

export let vibeCodingConfig: VibeCodingConfig = {
    showPopups: false,  // Default to no popups per user preference
};

export const categoryVoiceMap: Record<string, string> = {
    // ===== CURRENT WORKING CATEGORIES =====
    variable: 'en_3',
    operator: 'en_15',
    keyword: 'en_35', // def, if, for, etc.
    literal: 'en_5',
    regex: 'en_5', // Use same voice as literal for regex patterns
    comment: 'en_41',
    type: 'en_80',

    // These are the categories the system actually provides:
    
    // variable: 'en_3',     // 🔵 Words: function names, variables, classes, etc. (add_talk_simple, PTC, text, font)
    // operator: 'en_15',    // 🟠 Math operators: +, -, *, /, = 
    // type: 'en_80',        // 🟡 Punctuation & symbols: (), [], {}, quotes, dots, commas
    // comment: 'en_41',     // 🟢 Comment text
    
    // // ===== FUTURE SEMANTIC TOKEN CATEGORIES =====
    // // These will work when semantic token support is added:
    
    // // Keywords & Control Flow
    // keyword: 'en_35',                // def, if, for, while, class
    // 'keyword.control': 'en_35',      // if, for, while, def, class  
    // 'keyword.operator': 'en_15',     // and, or, not, in, is
    // 'keyword.import': 'en_90',       // import, from, as
    
    // // Functions & Methods
    // 'function.name': 'en_10',        // Function definitions (add_talk_simple)
    // 'function.call': 'en_12',        // Method calls (.create_clip, .size)
    // 'function.builtin': 'en_20',     // Built-in functions (int, max, len)
    
    // // Strings & Literals
    // 'string': 'en_25',               // String literals ("black", "center")
    // 'string.quoted': 'en_25',        // Quoted strings
    // literal: 'en_25',                // String literals (fallback)
    
    // // Numbers
    // 'number': 'en_30',               // Numbers (70, 100, 50)
    // 'number.integer': 'en_30',       // Integer numbers
    // 'number.float': 'en_32',         // Float numbers
    
    // // Classes & Types
    // 'type.class': 'en_40',           // Class names (PTC, ImageClip)
    // 'class.name': 'en_40',           // Class names
    // 'class.builtin': 'en_42',        // Built-in classes
    
    // // Parameters & Properties
    // 'parameter': 'en_50',            // Function parameters (text, font, fontsize)
    // 'parameter.name': 'en_50',       // Parameter names
    // 'property': 'en_60',             // Object properties (.h, .w)
    // 'property.name': 'en_60',        // Property names
    
    // // Punctuation (more specific)
    // 'punctuation': 'en_70',          // General punctuation
    // 'punctuation.bracket': 'en_70',  // (), [], {}
    // 'punctuation.delimiter': 'en_72', // , : ;
    
    // // Constants
    // 'constant': 'en_75',             // Constants (True, False, None)
    // 'constant.builtin': 'en_75',     // Built-in constants
    
    // // Modules & Namespaces
    // 'namespace': 'en_85',            // Module names, imports
    // 'module': 'en_85',               // Module references
    
    // // Special categories
    // 'special': 'en_5',               // Special characters during typing
    
    // // Default fallback
    // 'text': 'en_5',                  // Plain text
    // 'default': 'en_5',               // Fallback voice
};

// Espeak voice mapping for different categories
export const espeakCategoryVoiceMap: Record<string, Partial<EspeakConfig>> = {
    // Different voices and settings for semantic categories
    // Note: espeak-ng doesn't have multiple speakers like Silero, so we use different
    // language variants and parameter changes to create variety
    
    variable: { defaultVoice: 'en-us', pitch: 50, speed: 220, amplitude: 100 },     // Variables, function names - default US voice
    operator: { defaultVoice: 'en-gb', pitch: 60, speed: 230, amplitude: 110 },    // Math operators - higher pitch British voice
    literal: { defaultVoice: 'en-us', pitch: 48, speed: 200, amplitude: 95 },      // String literals - softer US voice
    regex: { defaultVoice: 'en-us', pitch: 48, speed: 200, amplitude: 95 },        // Regex patterns - same as literals
    type: { defaultVoice: 'en-gb-x-rp', pitch: 40, speed: 210, amplitude: 90 },   // Punctuation & symbols - lower pitch RP voice
    comment: { defaultVoice: 'en-us', pitch: 45, speed: 200, amplitude: 85 },      // Comments - softer US voice
    
    // Future semantic categories
    keyword: { defaultVoice: 'en+f2', pitch: 55, speed: 220, amplitude: 105 },                // Keywords - English female voice
    'keyword.control': { defaultVoice: 'en+f2', pitch: 55, speed: 220, amplitude: 105 },
    'keyword.operator': { defaultVoice: 'en+f2', pitch: 60, speed: 230, amplitude: 110 },
    'keyword.import': { defaultVoice: 'en+f2', pitch: 48, speed: 210, amplitude: 95 },
    
    'function.name': { defaultVoice: 'en-us', pitch: 52, speed: 220, amplitude: 100 },
    'function.call': { defaultVoice: 'en-us', pitch: 50, speed: 220, amplitude: 100 },
    'function.builtin': { defaultVoice: 'en-gb', pitch: 58, speed: 230, amplitude: 105 },
    
    'string': { defaultVoice: 'en-us', pitch: 45, speed: 200, amplitude: 85 },
    'string.quoted': { defaultVoice: 'en-us', pitch: 45, speed: 200, amplitude: 85 },
    
    'number': { defaultVoice: 'en-gb-x-rp', pitch: 55, speed: 230, amplitude: 100 },
    'number.integer': { defaultVoice: 'en-gb-x-rp', pitch: 55, speed: 230, amplitude: 100 },
    'number.float': { defaultVoice: 'en-gb-x-rp', pitch: 53, speed: 220, amplitude: 100 },
    
    'type.class': { defaultVoice: 'en-gb-scotland', pitch: 48, speed: 170, amplitude: 95 },
    'class.name': { defaultVoice: 'en-gb-scotland', pitch: 48, speed: 170, amplitude: 95 },
    'class.builtin': { defaultVoice: 'en-gb', pitch: 50, speed: 175, amplitude: 100 },
    
    'parameter': { defaultVoice: 'en-us', pitch: 52, speed: 175, amplitude: 95 },
    'parameter.name': { defaultVoice: 'en-us', pitch: 52, speed: 175, amplitude: 95 },
    'property': { defaultVoice: 'en-us', pitch: 50, speed: 175, amplitude: 100 },
    'property.name': { defaultVoice: 'en-us', pitch: 50, speed: 175, amplitude: 100 },
    
    'punctuation': { defaultVoice: 'en-gb-x-rp', pitch: 40, speed: 200, amplitude: 80 },
    'punctuation.bracket': { defaultVoice: 'en-gb-x-rp', pitch: 40, speed: 200, amplitude: 80 },
    'punctuation.delimiter': { defaultVoice: 'en-gb-x-rp', pitch: 38, speed: 210, amplitude: 75 },
    
    'constant': { defaultVoice: 'en-gb', pitch: 55, speed: 170, amplitude: 100 },
    'constant.builtin': { defaultVoice: 'en-gb', pitch: 55, speed: 170, amplitude: 100 },
    
    'namespace': { defaultVoice: 'en-gb-scotland', pitch: 48, speed: 165, amplitude: 95 },
    'module': { defaultVoice: 'en-gb-scotland', pitch: 48, speed: 165, amplitude: 95 },
    
    'special': { defaultVoice: 'en-us', pitch: 65, speed: 190, amplitude: 120 },   // Special characters - higher energy
    
    'text': { defaultVoice: 'en-us', pitch: 50, speed: 175, amplitude: 100 },
    'default': { defaultVoice: 'en-us', pitch: 50, speed: 175, amplitude: 100 },
};

// OpenAI TTS voice mapping for different categories (Korean voices)
export const openaiCategoryVoiceMap: Record<string, Partial<OpenAITTSConfig>> = {
    // Different voices and settings for semantic categories using OpenAI TTS
    // OpenAI TTS voices: alloy, echo, fable, onyx, nova, shimmer
    
    variable: { voice: 'alloy', speed: 1.0 },       // Variables, function names - clear neutral voice
    operator: { voice: 'echo', speed: 1.1 },        // Math operators - slightly faster, distinct voice
    type: { voice: 'fable', speed: 0.9 },           // Punctuation & symbols - slower, softer voice
    comment: { voice: 'nova', speed: 0.8 },         // Comments - slower, gentle voice
    
    // Future semantic categories
    keyword: { voice: 'onyx', speed: 1.0 },                        // Keywords - strong voice
    'keyword.control': { voice: 'onyx', speed: 1.0 },
    'keyword.operator': { voice: 'echo', speed: 1.1 },
    'keyword.import': { voice: 'shimmer', speed: 0.9 },
    
    'function.name': { voice: 'alloy', speed: 1.0 },
    'function.call': { voice: 'alloy', speed: 1.0 },
    'function.builtin': { voice: 'echo', speed: 1.1 },
    
    'string': { voice: 'nova', speed: 0.8 },
    'string.quoted': { voice: 'nova', speed: 0.8 },
    literal: { voice: 'nova', speed: 0.8 },
    
    'number': { voice: 'fable', speed: 1.2 },
    'number.integer': { voice: 'fable', speed: 1.2 },
    'number.float': { voice: 'fable', speed: 1.1 },
    
    'type.class': { voice: 'shimmer', speed: 0.9 },
    'class.name': { voice: 'shimmer', speed: 0.9 },
    'class.builtin': { voice: 'onyx', speed: 1.0 },
    
    'parameter': { voice: 'alloy', speed: 1.0 },
    'parameter.name': { voice: 'alloy', speed: 1.0 },
    'property': { voice: 'alloy', speed: 1.0 },
    'property.name': { voice: 'alloy', speed: 1.0 },
    
    'punctuation': { voice: 'fable', speed: 1.5 },
    'punctuation.bracket': { voice: 'fable', speed: 1.5 },
    'punctuation.delimiter': { voice: 'fable', speed: 1.6 },
    
    'constant': { voice: 'onyx', speed: 1.0 },
    'constant.builtin': { voice: 'onyx', speed: 1.0 },
    
    'namespace': { voice: 'shimmer', speed: 0.9 },
    'module': { voice: 'shimmer', speed: 0.9 },
    
    'special': { voice: 'echo', speed: 1.3 },   // Special characters - faster, more energetic
    
    'text': { voice: 'alloy', speed: 1.0 },
    'default': { voice: 'alloy', speed: 1.0 },
};

// macOS voice mapping for different categories
export const macosCategoryVoiceMap: Record<string, Partial<MacOSConfig>> = {
    // Different voices and settings for semantic categories using macOS native voices
    // Popular macOS voices: Alex, Samantha, Victoria, Daniel, Karen, Moira, Tessa, Veena, Fiona
    
    variable: { defaultVoice: 'Yuna', rate: 200, volume: 0.7 },        // Variables, function names - Yuna for consistency
    operator: { defaultVoice: 'Yuna', rate: 220, volume: 0.8 },        // Math operators - slightly faster
    literal: { defaultVoice: 'Yuna', rate: 190, volume: 0.65 },        // String literals - slightly slower
    regex: { defaultVoice: 'Yuna', rate: 190, volume: 0.65 },          // Regex patterns - same as literals
    type: { defaultVoice: 'Yuna', rate: 180, volume: 0.6 },            // Punctuation & symbols - slower
    comment: { defaultVoice: 'Yuna', rate: 170, volume: 0.6 },         // Comments - slower, gentle
    
    // Future semantic categories
    keyword: { defaultVoice: 'Daniel', rate: 200, volume: 0.75 },                        // Keywords - male voice
    'keyword.control': { defaultVoice: 'Daniel', rate: 200, volume: 0.75 },
    'keyword.operator': { defaultVoice: 'Daniel', rate: 220, volume: 0.8 },
    'keyword.import': { defaultVoice: 'Daniel', rate: 180, volume: 0.65 },
    
    'function.name': { defaultVoice: 'Yuna', rate: 200, volume: 0.7 },
    'function.call': { defaultVoice: 'Yuna', rate: 200, volume: 0.7 },
    'function.builtin': { defaultVoice: 'Yuna', rate: 220, volume: 0.8 },
    
    'string': { defaultVoice: 'Yuna', rate: 170, volume: 0.6 },
    'string.quoted': { defaultVoice: 'Yuna', rate: 170, volume: 0.6 },
    
    'number': { defaultVoice: 'Yuna', rate: 230, volume: 0.7 },
    'number.integer': { defaultVoice: 'Yuna', rate: 230, volume: 0.7 },
    'number.float': { defaultVoice: 'Yuna', rate: 220, volume: 0.7 },
    
    'type.class': { defaultVoice: 'Yuna', rate: 180, volume: 0.65 },
    'class.name': { defaultVoice: 'Yuna', rate: 180, volume: 0.65 },
    'class.builtin': { defaultVoice: 'Yuna', rate: 190, volume: 0.7 },
    
    'parameter': { defaultVoice: 'Yuna', rate: 190, volume: 0.65 },
    'parameter.name': { defaultVoice: 'Yuna', rate: 190, volume: 0.65 },
    'property': { defaultVoice: 'Yuna', rate: 190, volume: 0.7 },
    'property.name': { defaultVoice: 'Yuna', rate: 190, volume: 0.7 },
    
    'punctuation': { defaultVoice: 'Yuna', rate: 250, volume: 0.5 },
    'punctuation.bracket': { defaultVoice: 'Yuna', rate: 250, volume: 0.5 },
    'punctuation.delimiter': { defaultVoice: 'Yuna', rate: 260, volume: 0.45 },
    
    'constant': { defaultVoice: 'Yuna', rate: 190, volume: 0.7 },
    'constant.builtin': { defaultVoice: 'Yuna', rate: 190, volume: 0.7 },
    
    'namespace': { defaultVoice: 'Yuna', rate: 175, volume: 0.65 },
    'module': { defaultVoice: 'Yuna', rate: 175, volume: 0.65 },
    
    'special': { defaultVoice: 'Yuna', rate: 240, volume: 0.9 },   // Special characters - faster, more energetic
    
    'text': { defaultVoice: 'Yuna', rate: 200, volume: 0.7 },
    'default': { defaultVoice: 'Yuna', rate: 200, volume: 0.7 },
};

// Allow runtime switching of TTS backend & config
export function setBackend(backend: TTSBackend, sileroPartial?: Partial<SileroConfig>, espeakPartial?: Partial<EspeakConfig>, openaiPartial?: Partial<OpenAITTSConfig>, xttsV2Partial?: Partial<XTTSV2Config>, macosPartial?: Partial<MacOSConfig>) {
    currentBackend = backend;
    
    // Apply partial configs based on what the combined backend uses
    if ((backend === TTSBackend.SileroGPT || backend === TTSBackend.XTTSV2) && sileroPartial) {
        sileroConfig = { ...sileroConfig, ...sileroPartial };
    }
    if ((backend === TTSBackend.EspeakGPT) && espeakPartial) {
        espeakConfig = { ...espeakConfig, ...espeakPartial };
    }
    if ((backend === TTSBackend.SileroGPT || backend === TTSBackend.EspeakGPT || backend === TTSBackend.MacOSGPT) && openaiPartial) {
        openaiTTSConfig = { ...openaiTTSConfig, ...openaiPartial };
    }
    if (backend === TTSBackend.XTTSV2 && xttsV2Partial) {
        xttsV2Config = { ...xttsV2Config, ...xttsV2Partial };
    }
    if ((backend === TTSBackend.MacOSGPT || backend === TTSBackend.MacOS) && macosPartial) {
        macosConfig = { ...macosConfig, ...macosPartial };
    }
}

// Allow runtime switching of ASR backend & config
export function setASRBackend(backend: ASRBackend, sileroASRPartial?: Partial<SileroASRConfig>, gpt4oASRPartial?: Partial<GPT4oASRConfig>) {
    currentASRBackend = backend;
    if (backend === ASRBackend.Silero && sileroASRPartial) {
        sileroASRConfig = { ...sileroASRConfig, ...sileroASRPartial };
    } else if (backend === ASRBackend.GPT4o && gpt4oASRPartial) {
        gpt4oASRConfig = { ...gpt4oASRConfig, ...gpt4oASRPartial };
    }
}

// Allow runtime switching of LLM backend & config
export function setLLMBackend(backend: LLMBackend, claudePartial?: Partial<ClaudeConfig>) {
    currentLLMBackend = backend;
    if (backend === LLMBackend.Claude && claudePartial) {
        claudeConfig = { ...claudeConfig, ...claudePartial };
    }
}

// Earcon Mode Configuration ─────────────────────────────────────────────────────
export enum EarconMode {
    Sound = 'sound',           // Play earcon sounds for all characters
    Text = 'text',             // Speak earcons as text for all characters
    ParenthesesOnly = 'paren'  // Use earcon sounds for ( ), and enter; text for everything else
}

// Mutable earcon mode state
export const earconModeState = {
    mode: EarconMode.ParenthesesOnly  // Default to parentheses-only earcon mode
};

// Earcon to spoken text mappings for text mode
export const earconTextMap: Record<string, string> = {
    // Parentheses & brackets
    '(': 'left parenthesis',
    ')': 'right parenthesis',
    '[': 'left bracket',
    ']': 'right bracket',
    '{': 'left brace',
    '}': 'right brace',
    '<': 'less than',
    '>': 'greater than',

    // Quotes
    '"': 'double quote',
    "'": 'single quote',
    '`': 'backtick',

    // Basic punctuation
    '.': 'dot',
    ',': 'comma',
    ';': 'semicolon',
    ':': 'colon',
    '_': 'underscore',     // changed from underbar
    '-': 'minus',          // better than dash (used in math & code)

    // Operators
    '=': 'equals',
    '+': 'plus',
    '*': 'asterisk',
    '/': 'slash',
    '\\': 'backslash',
    '|': 'vertical bar',   // pipe is slang; vertical bar is canonical
    '&': 'ampersand',

    // Special characters
    '!': 'exclamation mark',
    '@': 'at sign',
    '#': 'hash',
    '$': 'dollar',
    '%': 'percent',
    '^': 'caret',
    '?': 'question mark',
    '~': 'tilde',
    '₩': 'won sign',

    // Multi-character operators
    '++': 'plus plus',                // often read literally
    '--': 'minus minus',
    '+=': 'plus equals',
    '-=': 'minus equals',
    '*=': 'times equals',
    '/=': 'divide equals',
    '==': 'equals equals',
    '!=': 'not equals',
    '===': 'triple equals',
    '!==': 'not triple equals',
    '<=': 'less than or equal',
    '>=': 'greater than or equal',
    '&&': 'logical and',
    '||': 'logical or',
    '//': 'double slash',
    '=>': 'arrow',

    // Whitespace
    ' ': 'space',
    '\t': 'tab',
    '\n': 'newline',
    
    // Special tokens
    'enter': 'enter',
    'backspace': 'backspace',
    'indent_increase': 'indent increase',
    'indent_decrease': 'indent decrease'
};

// Path and Etc Config ─────────────────────────────────────────────────────
export const config = {
    typingSpeechEnabled: true,  // global flag for typing speech
    cursorLineReadingEnabled: true,  // enable automatic line reading when cursor moves
    cursorWordReadingEnabled: true,  // enable reading the word on word-wise navigation (Option+Arrow)
    playSpeed: 2.0,              // playback speed multiplier - now supports pitch preservation!
    preservePitch: true,         // use pitch-preserving time stretching (requires FFmpeg)
    panningEnabled: true,        // enable positional panning for tokens (legacy)
    globalPanningEnabled: true,  // enable global panning system for ALL audio
    gentleAudioStopping: true,   // reduce aggressive audio stopping to minimize crackling
    backspaceEarconEnabled: false, // enable/disable backspace earcon playback
    
    // Latency Optimization ──────────────────────────────────────────────────────────
    reduceInterTokenDelay: true,  // minimize delays between spoken tokens for faster reading
    aggressiveAudioPipeline: true, // use smaller audio buffers for lower latency

    // Audio Minimap Configuration
    audioMinimapEnabled: false,  // disable audio minimap - removed feature
    audioMinimapSpeedThreshold: 3.5, // lines per second threshold to trigger minimap (increased to reduce false triggers)
    audioMinimapTimeout: 150,    // minimum milliseconds between line changes to calculate speed (reduced for more responsive detection)

    audioPath: () => {
        const root = safeGetExtRoot();
        return root ? path.join(root, 'client', 'audio') : '';
    },
    alphabetPath: () => {
        const root = safeGetExtRoot();
        return root ? path.join(
            root,
            'client',
            'audio',
            `alphabet${currentBackend === TTSBackend.Espeak ? '_espeak' : 
                       currentBackend === TTSBackend.MacOS || currentBackend === TTSBackend.MacOSGPT ? '_macos' : '_silero'}`
        ) : '';
    },
    earconPath: () => {
        const root = safeGetExtRoot();
        return root ? path.join(root, 'client', 'audio', 'earcon') : '';
    },
    numberPath: () => {
        const root = safeGetExtRoot();
        return root ? path.join(
            root,
            'client',
            'audio',
            `number${currentBackend === TTSBackend.Espeak ? '_espeak' : 
                     currentBackend === TTSBackend.MacOS || currentBackend === TTSBackend.MacOSGPT ? '_macos' : '_silero'}`
        ) : '';
    },
    pythonKeywordsPath: () => {
        const root = safeGetExtRoot();
        return root ? path.join(
            root,
            'client',
            'audio',
            `python${currentBackend === TTSBackend.Espeak ? '_espeak' : 
                     currentBackend === TTSBackend.MacOS || currentBackend === TTSBackend.MacOSGPT ? '_macos' : '_silero'}`
        ) : '';
    },
    typescriptKeywordsPath: () => {
        const root = safeGetExtRoot();
        return root ? path.join(
            root,
            'client',
            'audio',
            `typescript${currentBackend === TTSBackend.Espeak ? '_espeak' : 
                         currentBackend === TTSBackend.MacOS || currentBackend === TTSBackend.MacOSGPT ? '_macos' : '_silero'}`
        ) : '';
    },
    pythonPath: () => {
        const root = safeGetExtRoot();
        return root ? path.join(root, 'client', 'src', 'python', 'bin', 'python') : '';
    },
    scriptPath: () => {
        const root = safeGetExtRoot();
        return root ? path.join(root, 'client', 'src', 'python', 'silero_tts_infer.py') : '';
    },
    specialPath: () => {
        const audioPath = config.audioPath();
        return audioPath ? path.join(
            audioPath,
            `special${currentBackend === TTSBackend.Espeak ? '_espeak' : 
                      currentBackend === TTSBackend.MacOS || currentBackend === TTSBackend.MacOSGPT ? '_macos' : '_silero'}`
        ) : '';
    },
    musicalPath: () => {
        const audioPath = config.audioPath();
        return audioPath ? path.join(audioPath, 'musical') : '';
    },
    alertPath: () => {
        const audioPath = config.audioPath();
        return audioPath ? path.join(audioPath, 'alert') : '';
    },

} as {
    typingSpeechEnabled: boolean;
    cursorLineReadingEnabled: boolean;
    cursorWordReadingEnabled: boolean;
    playSpeed: number;
    preservePitch: boolean;
    panningEnabled: boolean;
    globalPanningEnabled: boolean;
    gentleAudioStopping: boolean;
    backspaceEarconEnabled: boolean;
    reduceInterTokenDelay: boolean;
    aggressiveAudioPipeline: boolean;
    audioMinimapEnabled: boolean;
    audioMinimapSpeedThreshold: number;
    audioMinimapTimeout: number;

    audioPath: () => string;
    alphabetPath: () => string;
    earconPath: () => string;
    numberPath: () => string;
    pythonKeywordsPath: () => string;
    typescriptKeywordsPath: () => string;
    pythonPath: () => string;
    scriptPath: () => string;
    specialPath: () => string;
    musicalPath: () => string;
    alertPath: () => string;
};

// Load configuration from VS Code settings
export function loadConfigFromSettings() {
    try {
        const vscode = require('vscode');
        
        // Check if workspace is available
        if (!vscode.workspace) {
            console.warn('[Config] VS Code workspace not available, using defaults');
            return;
        }
        
        const config = vscode.workspace.getConfiguration('lipcoder');
        
        // Load OpenAI API key for GPT-4o ASR
        const apiKey = config.get('openaiApiKey', '') as string;
        if (apiKey) {
            gpt4oASRConfig.apiKey = apiKey;
        }
        
        // Load ASR backend selection
        const asrBackend = config.get('asrBackend', 'huggingface-whisper') as string;
        if (asrBackend === 'silero') {
            currentASRBackend = ASRBackend.Silero;
        } else if (asrBackend === 'gpt4o-transcribe') {
            currentASRBackend = ASRBackend.GPT4o;
        } else if (asrBackend === 'huggingface-whisper') {
            currentASRBackend = ASRBackend.HuggingFaceWhisper;
        }
        
        // Load Whisper model
        const whisperModel = config.get('gpt4oModel', 'whisper-1') as string;
        gpt4oASRConfig.model = whisperModel;
        
        // Load ASR language (null for auto-detection, 'en' for English, 'ko' for Korean)
        const asrLanguage = config.get('asrLanguage', null) as string | null;
        
        // Validate ASR language setting
        if (asrLanguage !== null && asrLanguage !== 'en' && asrLanguage !== 'ko') {
            console.warn(`[Config] Invalid ASR language '${asrLanguage}', falling back to auto-detection`);
            gpt4oASRConfig.language = null;
        } else {
            gpt4oASRConfig.language = asrLanguage;
            if (asrLanguage) {
                console.log(`[Config] ASR language constraint set to: ${asrLanguage === 'en' ? 'English only' : 'Korean only'}`);
            } else {
                console.log('[Config] ASR language set to auto-detection (all languages)');
            }
        }
        
        // Load OpenAI TTS configuration
        if (apiKey) {
            openaiTTSConfig.apiKey = apiKey; // Reuse OpenAI API key for TTS
        }
        
        const ttsModel = config.get('openaiTTSModel', 'tts-1') as string;
        openaiTTSConfig.model = ttsModel;
        
        const ttsVoice = config.get('openaiTTSVoice', 'alloy') as string;
        openaiTTSConfig.voice = ttsVoice;
        
        const ttsLanguage = config.get('openaiTTSLanguage', 'ko') as string;
        openaiTTSConfig.language = ttsLanguage;
        
        const ttsSpeed = config.get('openaiTTSSpeed', 1.0) as number;
        openaiTTSConfig.speed = ttsSpeed;
        
        const ttsVolumeBoost = config.get('openaiTTSVolumeBoost', 1.3) as number;
        openaiTTSConfig.volumeBoost = ttsVolumeBoost;
        
        // Load TTS backend selection
        const ttsBackend = config.get('ttsBackend', 'macos') as string; // Changed default from 'espeak' to 'macos'
        if (ttsBackend === 'silero-gpt') {
            currentBackend = TTSBackend.SileroGPT;
        } else if (ttsBackend === 'espeak-gpt') {
            currentBackend = TTSBackend.EspeakGPT;
        } else if (ttsBackend === 'espeak') {
            currentBackend = TTSBackend.Espeak;
        } else if (ttsBackend === 'xtts-v2') {
            // XTTS disabled due to stability issues - fallback to MacOS
            console.warn('[Config] XTTS-v2 backend disabled due to stability issues, using MacOS instead');
            currentBackend = TTSBackend.MacOS;
        } else if (ttsBackend === 'macos-gpt') {
            currentBackend = TTSBackend.MacOSGPT;
        } else if (ttsBackend === 'macos') {
            currentBackend = TTSBackend.MacOS;
        }
        
        // Load XTTS-v2 configuration
        const xttsV2ServerUrl = config.get('xttsV2ServerUrl', 'http://localhost:5006/tts_fast') as string;
        xttsV2Config.serverUrl = xttsV2ServerUrl;
        
        const xttsV2SampleRate = config.get('xttsV2SampleRate', 24000) as number;
        xttsV2Config.sampleRate = xttsV2SampleRate;
        
        const xttsV2VolumeBoost = config.get('xttsV2VolumeBoost', 1.0) as number;
        xttsV2Config.volumeBoost = xttsV2VolumeBoost;
        
        const xttsV2SpeakerWav = config.get('xttsV2SpeakerWav', '') as string;
        if (xttsV2SpeakerWav) {
            xttsV2Config.speakerWav = xttsV2SpeakerWav;
        }
        
        // Load macOS TTS configuration
        const macosVoice = config.get('macosVoice', 'Alex') as string;
        macosConfig.defaultVoice = macosVoice;
        
        const macosRate = config.get('macosRate', 200) as number;
        macosConfig.rate = macosRate;
        
        const macosVolume = config.get('macosVolume', 0.7) as number;
        macosConfig.volume = macosVolume;
        
        const macosSampleRate = config.get('macosSampleRate', 24000) as number;
        macosConfig.sampleRate = macosSampleRate;
        
        // Load LLM backend selection
        const llmBackend = config.get('llmBackend', 'claude') as string;
        if (llmBackend === 'chatgpt') {
            currentLLMBackend = LLMBackend.ChatGPT;
        } else if (llmBackend === 'claude') {
            currentLLMBackend = LLMBackend.Claude;
        }
        
        // Load Claude configuration
        const claudeApiKey = config.get('claudeApiKey', '') as string;
        if (claudeApiKey) {
            claudeConfig.apiKey = claudeApiKey;
        }
        
        const claudeModel = config.get('claudeModel', 'claude-sonnet-4-20250514') as string;
        claudeConfig.model = claudeModel;
        
        const claudeMaxTokens = config.get('claudeMaxTokens', 2000) as number;
        claudeConfig.maxTokens = claudeMaxTokens;
        
        const claudeTemperature = config.get('claudeTemperature', 0.1) as number;
        claudeConfig.temperature = claudeTemperature;
        
        // Load vibe coding popup preferences
        const vibeCodingShowPopups = config.get('vibeCodingShowPopups', false) as boolean;
        vibeCodingConfig.showPopups = vibeCodingShowPopups;

        // Load cursor word reading preference
        const cursorWordReadingEnabled = config.get('cursorWordReadingEnabled', true) as boolean;
        // Update runtime flag
        try {
            (config as any).cursorWordReadingEnabled = cursorWordReadingEnabled;
        } catch {
            // Fallback direct assignment
            // @ts-ignore
            config.cursorWordReadingEnabled = cursorWordReadingEnabled;
        }
        
        console.log('[Config] Configuration loaded successfully');
    } catch (error) {
        console.error('[Config] Failed to load configuration from VS Code settings:', error);
        // Use defaults on error
    }
}

const specialMap: Record<string, string> =  {
    '!': 'excitation.pcm', '@': 'at.pcm', '#': 'sharp.pcm', '$': 'dollar.pcm',
    '%': 'percent.pcm', '^': 'caret.pcm', '&': 'ampersand.pcm', '*': 'asterisk.pcm',
    '+': 'plus.pcm', '~': 'tilde.pcm', '|': 'bar.pcm', '?': 'question.pcm',
    '₩': 'won.pcm', '=': 'equals.pcm', '`': 'backtick.pcm', '\\': 'backslash.pcm',
};
