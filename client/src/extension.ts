import * as vscode from 'vscode';
import { setBackend, TTSBackend } from './config';
import { createAudioMap } from './mapping';
import { preloadEverything } from './preload';
import { config, initConfig } from './config';
import { installDependencies } from './install_dependencies';
import { log, logWarning, logSuccess, logError, logMemory, initializeLogging } from './utils';

import { registerEchoTest } from './features/echo_test';
import { registerWhereAmI } from './features/where_am_i';
import { registerReadLineTokens } from './features/read_line_tokens';
import { loadDictionaryWord } from './features/word_logic';
import { registerStopReading } from './features/stop_reading';
import { registerToggleTypingSpeech } from './features/toggle_typing_speech';
import { startLanguageClient, restartLanguageClient, getLanguageClient } from './language_client';
import { registerCurrentLine } from './features/current_line';
import { registerReadFunctionTokens } from './features/read_function_tokens';
import { registerBreadcrumb } from './features/breadcrumb';
import { registerSymbolTree } from './features/symbol_tree';
import { registerSwitchPanel } from './features/switch_panel';
import { registerFunctionList } from './features/function_list';
import { registerFileTree } from './features/file_tree';
import { registerFileSearchExplorer } from './features/file_search_explorer';
import { registerFileExecutor } from './features/file_executor';
import { registerCSVFileChecker } from './features/csv_file_checker';
import { registerUniversalFileChecker } from './features/universal_file_checker';
import { registerLLMBashGenerator } from './features/llm_bash_generator';
import { registerTerminalReader } from './features/terminal';
import { registerFormatCode } from './features/format_code';
import { registerNavExplorer } from './features/nav_explorer';
import { registerNavEditor } from './features/nav_editor';
import { registerEditorWordNav } from './features/editor_word_nav';
import { registerPlaySpeed } from './features/playspeed';

import { registerChatCompletions } from './llm';
import { registerSetAPIKey } from './features/set_api_key';
import { registerVibeCodingCommands } from './features/vibe_coding';

import { registerCodeAnalysis } from './features/code_analysis';
import { registerLLMQuestion } from './features/llm_question';
import { registerEnhancedPushToTalkASR } from './features/enhanced_push_to_talk_asr';
import { registerTogglePanning } from './features/toggle_panning';
import { registerTTSBackendSwitch } from './features/tts_backend_switch';
import { registerLLMBackendSwitch } from './features/llm_backend_switch';
import { registerEarconModeCommands } from './features/earcon_mode_toggle';
import { registerOpenFile } from './features/open_file';
import { registerOpenPng } from './features/open_png';
import { registerSyntaxErrors } from './features/syntax_errors';
import { registerTestKoreanTTS } from './features/test_korean_tts';
import { registerTestXTTSInference } from './features/test_xtts_inference';
import { registerDebugOutput } from './features/debug_output';
import { registerClipboardAudio } from './features/clipboard_audio';
import { serverManager } from './server_manager';
import { activityLogger, logFeatureUsage, logExtensionLifecycle } from './activity_logger';
import { initializeEditorTracking } from './features/last_editor_tracker';
import { initializeTabTracking } from './features/tab_tracker';
import { comprehensiveEventTracker } from './comprehensive_event_tracker';
import { registerTestTabTracker } from './features/test_tab_tracker';
import { disposeCommandsWithPrefix } from './command_utils';
import { registerImageDescription } from './features/image_description';
import { registerExactCommandPalette, registerShowExactCommandsHelp } from './features/exact_command_palette';
import { registerNaturalLanguageCommand } from './features/natural_language_command';
import { registerDependencyCommands, checkAndInstallAllDependencies } from './features/dependency_installer';

import { getConversationalProcessor } from './conversational_asr';
import { getConversationalPopup } from './conversational_popup';
import { initializeASROptimizations } from './features/asr_speed_optimizer';
import { initializeLLMOptimizations } from './features/llm_speed_optimizer';
import { registerSpeedTestCommand } from './features/speed_test_command';
import { registerTestSuggestionStorage } from './features/test_suggestion_storage';

// Memory monitoring
let memoryMonitorInterval: NodeJS.Timeout | null = null;

function startMemoryMonitoring(): void {
    if (memoryMonitorInterval) {
        return;
    }
    
    let lastMemoryUsage = process.memoryUsage();
    let logCounter = 0;
    
    memoryMonitorInterval = setInterval(() => {
        const currentMemory = process.memoryUsage();
        const heapUsedDelta = currentMemory.heapUsed - lastMemoryUsage.heapUsed;
        const rssUsedDelta = currentMemory.rss - lastMemoryUsage.rss;
        
        // Log more frequently and at lower thresholds to catch memory issues
        if (logCounter % 5 === 0 || heapUsedDelta > 5 * 1024 * 1024) { // Every 2.5 minutes or 5MB growth
            logMemory(`[Memory] Heap: ${(currentMemory.heapUsed / 1024 / 1024).toFixed(2)}MB (+${(heapUsedDelta / 1024 / 1024).toFixed(2)}MB), RSS: ${(currentMemory.rss / 1024 / 1024).toFixed(2)}MB (+${(rssUsedDelta / 1024 / 1024).toFixed(2)}MB)`);
        }
        
        // Trigger aggressive cleanup if memory usage is too high
        if (currentMemory.heapUsed > 80 * 1024 * 1024) { // 80MB heap threshold
            logWarning(`[Memory] High memory usage detected (${(currentMemory.heapUsed / 1024 / 1024).toFixed(2)}MB), triggering cleanup`);
            try {
                const { cleanupAudioResources } = require('./audio');
                const { getLineTokenReadingActive } = require('./features/stop_reading');
                
                // Don't interrupt line token reading for memory cleanup
                if (getLineTokenReadingActive()) {
                    logWarning(`[Memory] Skipping cleanup during line token reading to avoid interruption`);
                } else {
                    cleanupAudioResources();
                }
            } catch (err) {
                logError(`Failed to cleanup during high memory usage: ${err}`);
            }
        }
        
        lastMemoryUsage = currentMemory;
        logCounter++;
    }, 30000); // Check every 30 seconds
    
    logMemory('[Memory] Memory monitoring started');
}

function stopMemoryMonitoring(): void {
    if (memoryMonitorInterval) {
        clearInterval(memoryMonitorInterval);
        memoryMonitorInterval = null;
        logMemory('[Memory] Memory monitoring stopped');
    }
}

export async function activate(context: vscode.ExtensionContext) {
    // Prevent duplicate activation within the same Extension Host
    if ((global as any).__lipcoderActivated) {
        logWarning('[Extension] Duplicate activation detected, skipping.');
        return;
    }
    (global as any).__lipcoderActivated = true;
    
    // Track activation start time
    const activationStartTime = Date.now();
    
    // Initialize logging first so debug output is visible
    initializeLogging();
    
    // Store context for global cleanup
    (global as any).lipcoderContext = context;
    
    // Clean up any existing lipcoder commands to prevent duplicate registration
    try {
        // Clear any existing subscriptions first
        if (context.subscriptions.length > 0) {
            log(`[Extension] Disposing ${context.subscriptions.length} existing subscriptions`);
            context.subscriptions.forEach(disposable => {
                try {
                    disposable.dispose();
                } catch (e) {
                    // Ignore disposal errors
                }
            });
            context.subscriptions.length = 0;
        }
        
        // Check for existing lipcoder commands and attempt cleanup
        const { commandExists, forceDisposeLipcoderCommands } = require('./command_utils');
        
        // Attempt to dispose any existing lipcoder commands
        await forceDisposeLipcoderCommands();
        
        const lipcoderCommands = [
            // 'lipcoder.syntaxErrorList',
            'lipcoder.syntaxErrorList',
            'lipcoder.nextSyntaxError', 
            'lipcoder.previousSyntaxError',
            'lipcoder.firstSyntaxError'
        ];
        
        for (const cmd of lipcoderCommands) {
            const exists = await commandExists(cmd);
            if (exists) {
                logWarning(`[Extension] Command ${cmd} still exists after cleanup attempt`);
            }
        }
        
        log('[Extension] Cleaned up existing subscriptions and checked command registry');
    } catch (error) {
        logWarning(`[Extension] Failed to clean up existing subscriptions: ${error}`);
    }
    
	// 0) Enhanced dependency installation ──────────────────────────────────────────────
	log('Extension Host running on Electron v' + process.versions.electron);
	
	// 기존 간단한 의존성 체크 (백그라운드)
	installDependencies().catch(err => console.error('installDependencies failed:', err));
	
	// 새로운 포괄적인 의존성 체크 (사용자 상호작용 포함)
	// 첫 번째 활성화에서만 실행하도록 설정
	const hasRunDependencyCheck = context.globalState.get('lipcoderDependencyCheckCompleted', false);
	if (!hasRunDependencyCheck) {
		log('🔧 첫 번째 실행: 포괄적인 의존성 체크를 시작합니다...');
		
		// 비동기로 실행하여 확장 활성화를 차단하지 않음
		setTimeout(async () => {
			try {
				await checkAndInstallAllDependencies();
				// 체크 완료 표시
				context.globalState.update('lipcoderDependencyCheckCompleted', true);
				log('✅ 의존성 체크가 완료되었습니다');
			} catch (error) {
				logError(`❌ 의존성 체크 중 오류 발생: ${error}`);
			}
		}, 2000); // 2초 후 실행 (확장 로딩 완료 후)
	} else {
		log('ℹ️ 의존성 체크를 이미 완료했습니다. 수동으로 다시 실행하려면 "LipCoder: Check Dependencies" 명령어를 사용하세요.');
	}

	// Start memory monitoring
	startMemoryMonitoring();

	// 1) Provide the extension root to config ───────────────────────────────────────────
	initConfig(context);
	
	// 1.2) Load configuration from VS Code settings ─────────────────────────────────────
	const { loadConfigFromSettings } = require('./config');
	loadConfigFromSettings();

	// 1.3) Initialize editor tracking for terminal ASR support ──────────────────────────
	initializeEditorTracking(context);
	
	// 1.3.1) Initialize last editor tracking for fallback support ──────────────────────
	const { initializeLastEditorTracking } = require('./ide/active');
	initializeLastEditorTracking(context);
	
	// 1.4) Initialize tab tracking for tab-aware file opening ───────────────────────────
	initializeTabTracking(context);
	
	// 1.5) Realtime command router removed - using comprehensive CommandRouter instead
	
	// 1.6) Initialize speed optimizations ──────────────────────────────────────────────
	try {
		log('⚡ Initializing speed optimizations...');
		
		// Initialize ASR speed optimizations (pre-warming, caching)
		initializeASROptimizations();
		log('✅ ASR speed optimizations initialized');
		
		// Initialize LLM speed optimizations (caching, batching)
		initializeLLMOptimizations();
		log('✅ LLM speed optimizations initialized');
		
		log('✅ Speed optimizations fully initialized');
	} catch (error) {
		logError(`❌ Failed to initialize speed optimizations: ${error}`);
		logWarning('⚠️ Extension will continue without speed optimizations');
	}

	// 1.7) Initialize conversational ASR system ─────────────────────────────────────────
	try {
		log('🤖 Starting conversational ASR system initialization...');
		
		// Initialize conversational processor
		try {
			log('🔄 Creating conversational processor...');
			const processor = getConversationalProcessor();
			log('✅ Conversational processor created successfully');
		} catch (processorError) {
			logError(`❌ Failed to create conversational processor: ${processorError}`);
			throw processorError;
		}
		
		// Initialize conversational popup
		try {
			log('🔄 Creating conversational popup...');
			const popup = getConversationalPopup();
			log('✅ Conversational popup created successfully');
		} catch (popupError) {
			logError(`❌ Failed to create conversational popup: ${popupError}`);
			throw popupError;
		}
		
		log('✅ Conversational ASR system fully initialized');
	} catch (error) {
		logError(`❌ Failed to initialize conversational ASR system: ${error}`);
		if (error instanceof Error) {
			logError(`❌ Error message: ${error.message}`);
			logError(`❌ Error stack: ${error.stack}`);
		}
		// Don't throw - let extension continue without conversational features
		logWarning('⚠️ Extension will continue without conversational features');
	}

	// 1.5) Clean old corrupted cache files on startup ───────────────────────────────────
	try {
		const fs = require('fs');
		const path = require('path');
		const os = require('os');
		
		const timeStretchCacheDir = path.join(os.tmpdir(), 'lipcoder_timestretch');
		if (fs.existsSync(timeStretchCacheDir)) {
			const files = fs.readdirSync(timeStretchCacheDir);
			const now = Date.now();
			let cleanedCount = 0;
			
			// Remove cache files older than 24 hours
			for (const file of files) {
				const filePath = path.join(timeStretchCacheDir, file);
				if (fs.statSync(filePath).isFile()) {
					const ageMs = now - fs.statSync(filePath).mtime.getTime();
					const ageHours = ageMs / (1000 * 60 * 60);
					
					if (ageHours > 24) {
						fs.unlinkSync(filePath);
						cleanedCount++;
					}
				}
			}
			
			if (cleanedCount > 0) {
				log(`[Startup] Cleaned ${cleanedCount} old cache files (>24h)`);
			}
		}
	} catch (error) {
		logWarning(`[Startup] Cache cleanup failed: ${error}`);
	}

	// 2) Start TTS and ASR servers ──────────────────────────────────────────────────────
	try {
		await serverManager.startServers();
		logSuccess('✅ All servers started successfully');
	} catch (error) {
		logError(`❌ Failed to start servers: ${error}`);
		vscode.window.showErrorMessage(`Failed to start lipcoder servers: ${error}`);
		// Continue anyway - some features may still work without servers
	}

	// 3) TTS setup ───────────────────────────────────────────────────────────────────────
	await loadDictionaryWord();
	    setBackend(TTSBackend.SileroGPT);

	// 3) Pre-generate earcons into cache ────────────────────────────
	preloadEverything(context);

	// 3.1) Warm up alphabet PCM cache for low-latency letter playback
	try {
		const { preloadAlphabetPCM } = require('./audio');
		preloadAlphabetPCM();
		log('✅ Alphabet PCM cache preloaded');
	} catch (err) {
		logWarning(`⚠️ Failed to preload alphabet PCM: ${err}`);
	}

	// 4) Build the unified audioMap ─────────────────────────────────────────────
	console.log('[EXTENSION] About to create audioMap...');
	const audioMapObj = createAudioMap(context);
	console.log('[EXTENSION] AudioMap created, underscore path:', audioMapObj.get('_'));
	
	// Convert Map to Record for compatibility with readTextTokens
	const audioMap: Record<string, string> = {};
	for (const [key, value] of audioMapObj.entries()) {
		audioMap[key] = value;
	}
	console.log('[EXTENSION] AudioMap converted to Record, alphabet "a":', audioMap['a']);
	console.log('[EXTENSION] AudioMap converted to Record, alphabet "b":', audioMap['b']);
	console.log('[EXTENSION] AudioMap keys count:', Object.keys(audioMap).length);

	// 5) Start LanguageClient ──────────────────────────────────────────────────
	const client = startLanguageClient(context);

	// 6) Register commands ───────────────────────────────────────────────────────
	try {
		log('📝 Registering core commands...');
		registerEchoTest(context, client);
		log('✅ registerEchoTest completed');
		
		registerWhereAmI(context, client);
		log('✅ registerWhereAmI completed');
		
		registerBreadcrumb(context, client);
		log('✅ registerBreadcrumb completed');
		
		registerReadLineTokens(context, client);
		log('✅ registerReadLineTokens completed');
		
		registerPlaySpeed(context);
		log('✅ registerPlaySpeed completed');
		
		registerReadFunctionTokens(context, client);
		log('✅ registerReadFunctionTokens completed');
		
		registerStopReading(context);
		log('✅ registerStopReading completed');
		
		registerToggleTypingSpeech(context, client);
		log('✅ registerToggleTypingSpeech completed');
		
		registerCurrentLine(context);
		log('✅ registerCurrentLine completed');
		
		registerSymbolTree(context);
		log('✅ registerSymbolTree completed');
		
		registerSwitchPanel(context);
		log('✅ registerSwitchPanel completed');
		
		registerFunctionList(context);
		log('✅ registerFunctionList completed');
		
		registerFileTree(context);
		log('✅ registerFileTree completed');
		
		registerFileSearchExplorer(context);
		log('✅ registerFileSearchExplorer completed');
		
		registerFileExecutor(context);
		log('✅ registerFileExecutor completed');
		
		registerCSVFileChecker(context);
		log('✅ registerCSVFileChecker completed');
		
		registerUniversalFileChecker(context);
		log('✅ registerUniversalFileChecker completed');
		
		registerLLMBashGenerator(context);
		log('✅ registerLLMBashGenerator completed');
		
		registerTerminalReader(context);
		log('✅ registerTerminalReader completed');
		
		registerFormatCode(context);
		log('✅ registerFormatCode completed');
		
		registerNavExplorer(context);
		log('✅ registerNavExplorer completed');
		
		registerNavEditor(context, audioMap);
		log('✅ registerNavEditor completed');
		
		registerEditorWordNav(context);
		log('✅ registerEditorWordNav completed');
		
		registerSetAPIKey(context);
		log('✅ registerSetAPIKey completed');
		
		registerChatCompletions(context);
		log('✅ registerChatCompletions completed');
		
		registerVibeCodingCommands(context);
		log('✅ registerVibeCodingCommands completed');
		

		
		registerCodeAnalysis(context);
		log('✅ registerCodeAnalysis completed');
		
		registerLLMQuestion(context);
		log('✅ registerLLMQuestion completed');

		log('📝 Registering ASR and advanced commands...');
		registerEnhancedPushToTalkASR(context);
		log('✅ registerEnhancedPushToTalkASR completed');
		
		registerTogglePanning(context);
		log('✅ registerTogglePanning completed');
		
		registerTTSBackendSwitch(context);
		log('✅ registerTTSBackendSwitch completed');
		
		registerLLMBackendSwitch(context);
		log('✅ registerLLMBackendSwitch completed');
		
		registerEarconModeCommands(context);
		log('✅ registerEarconModeCommands completed');
		
		registerOpenFile(context);
		log('✅ registerOpenFile completed');
		
		registerOpenPng(context);
		log('✅ registerOpenPng completed');
		
		await registerSyntaxErrors(context);
		log('✅ registerSyntaxErrors completed');
		
		registerTestKoreanTTS(context);
		log('✅ registerTestKoreanTTS completed');
		
		registerTestXTTSInference(context);
		log('✅ registerTestXTTSInference completed');
		
	} catch (error) {
		logError(`❌ Command registration failed: ${error}`);
		if (error instanceof Error) {
			logError(`❌ Registration error message: ${error.message}`);
			logError(`❌ Registration error stack: ${error.stack}`);
		}
		throw error; // Re-throw to see the full error
	}
	
	log('📝 Registering remaining commands...');
	registerDebugOutput(context);
	log('✅ registerDebugOutput completed');
	
	registerClipboardAudio(context);
	log('✅ registerClipboardAudio completed');
	
	registerTestTabTracker(context);
	log('✅ registerTestTabTracker completed');
	
	registerSpeedTestCommand(context);
	log('✅ registerSpeedTestCommand completed');
	
	registerImageDescription(context);
	log('✅ registerImageDescription completed');

	registerTestSuggestionStorage(context);
	log('✅ registerTestSuggestionStorage completed');

	// Register exact commands for Command Palette access
	await registerExactCommandPalette(context);
	log('✅ registerExactCommandPalette completed');
	
	registerShowExactCommandsHelp(context);
	log('✅ registerShowExactCommandsHelp completed');

	// Register natural language command functionality
	registerNaturalLanguageCommand(context);
	log('✅ registerNaturalLanguageCommand completed');
	
	// Register Dependency Management Commands
	registerDependencyCommands(context);
	log('✅ registerDependencyCommands completed');

	// Add command to restart language server
	try {
		log('📝 Registering restart language server command...');
		context.subscriptions.push(
			vscode.commands.registerCommand('lipcoder.restartLanguageServer', async () => {
				try {
					vscode.window.showInformationMessage('Restarting LipCoder Language Server...');
					const newClient = await restartLanguageClient(context);
					if (newClient) {
						vscode.window.showInformationMessage('LipCoder Language Server restarted successfully! Tokenization changes are now active.');
					} else {
						vscode.window.showErrorMessage('Failed to restart LipCoder Language Server. Check the output for details.');
					}
				} catch (error) {
					vscode.window.showErrorMessage(`Error restarting language server: ${error}`);
				}
			})
		);
		log('✅ Restart language server command registered');

		// Add command to test thinking audio
		log('📝 Registering test thinking audio command...');
		context.subscriptions.push(
			vscode.commands.registerCommand('lipcoder.testThinkingAudio', async () => {
				try {
					const { testThinkingAudio } = await import('./audio.js');
					await testThinkingAudio();
					vscode.window.showInformationMessage('Thinking audio test completed!');
				} catch (error) {
					vscode.window.showErrorMessage(`Thinking audio test failed: ${error}`);
				}
			})
		);
		log('✅ Test thinking audio command registered');
	} catch (error) {
		logError(`❌ Failed to register additional commands: ${error}`);
		if (error instanceof Error) {
			logError(`❌ Additional commands error message: ${error.message}`);
			logError(`❌ Additional commands error stack: ${error.stack}`);
		}
		throw error; // Re-throw to see the full error
	}


	// Add command to test comment voice
	context.subscriptions.push(
		vscode.commands.registerCommand('lipcoder.testCommentVoice', async () => {
			try {
				const { speakTokenList } = await import('./audio.js');
				const { getSpeakerForCategory } = await import('./tts.js');
				const { currentBackend } = await import('./config.js');
				
				// Log current backend and voice mappings
				console.log(`[CommentVoiceTest] Current TTS backend: ${currentBackend}`);
				console.log(`[CommentVoiceTest] Variable voice: ${getSpeakerForCategory('variable')}`);
				console.log(`[CommentVoiceTest] Comment voice: ${getSpeakerForCategory('comment_text')}`);
				console.log(`[CommentVoiceTest] Comment symbol voice: ${getSpeakerForCategory('comment_symbol')}`);
				
				await speakTokenList([
					{ tokens: ['Variable token'], category: 'variable' },
					{ tokens: ['Comment text'], category: 'comment_text' },
					{ tokens: ['#'], category: 'comment_symbol' }
				]);
				vscode.window.showInformationMessage('Comment voice test completed! Check console for voice mappings.');
			} catch (error) {
				vscode.window.showErrorMessage(`Comment voice test failed: ${error}`);
			}
		})
	);

	// Add command to test comment line tokenization
	context.subscriptions.push(
		vscode.commands.registerCommand('lipcoder.testCommentTokenization', async () => {
			try {
				const client = (await import('./language_client.js')).getLanguageClient();
				if (!client) {
					vscode.window.showErrorMessage('Language server not available');
					return;
				}

				// Test tokenization of a comment line
				const testUri = 'file:///test.py';
				const testLine = 0;
				
				// Request tokens from server
				const tokens = await client.sendRequest('lipcoder/readLineTokens', {
					uri: testUri,
					line: testLine
				}) as Array<{ text: string; category: string }>;
				
				console.log(`[CommentTokenizationTest] Tokens for "# This is a comment":`, tokens);
				
				// Test with the actual tokens from server
				const { speakTokenList } = await import('./audio.js');
				const chunks = tokens.map(token => ({
					tokens: [token.text],
					category: token.category
				}));
				
				await speakTokenList(chunks);
				vscode.window.showInformationMessage(`Comment tokenization test completed! Found ${tokens.length} tokens. Check console.`);
			} catch (error) {
				vscode.window.showErrorMessage(`Comment tokenization test failed: ${error}`);
			}
		})
	);

	// Add command to test activity logging
	context.subscriptions.push(
		vscode.commands.registerCommand('lipcoder.testActivityLogging', async () => {
			try {
				const { logFeatureUsage, logVibeCoding, logASRCommand, activityLogger } = await import('./activity_logger.js');
				
				// Test various log types
				logFeatureUsage('test_feature', 'test_action', { testData: 'test_value' });
				logVibeCoding('test_vibe_coding', 'test instruction', 'test_file.ts', { testChanges: 5 });
				logASRCommand('test_command', 'test transcription', 0.95, 2000);
				
				const logFile = activityLogger.getCurrentLogFile();
				vscode.window.showInformationMessage(`Activity logging test completed! Check log file: ${logFile}`);
				
				// Open log directory
				const logDir = activityLogger.getLogDir();
				vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(logDir), true);
				
			} catch (error) {
				vscode.window.showErrorMessage(`Activity logging test failed: ${error}`);
			}
		})
	);

	// Add command to open activity logs
	context.subscriptions.push(
		vscode.commands.registerCommand('lipcoder.openActivityLogs', async () => {
			try {
				const { activityLogger } = await import('./activity_logger.js');
				const logDir = activityLogger.getLogDir();
				const currentLogFile = activityLogger.getCurrentLogFile();
				
				// Open the current log file
				const document = await vscode.workspace.openTextDocument(currentLogFile);
				await vscode.window.showTextDocument(document);
				
				vscode.window.showInformationMessage(`Opened current activity log: ${currentLogFile}`);
				
			} catch (error) {
				vscode.window.showErrorMessage(`Failed to open activity logs: ${error}`);
			}
		})
	);

	// Add command to analyze metrics
	context.subscriptions.push(
		vscode.commands.registerCommand('lipcoder.analyzeMetrics', async () => {
			try {
				const { activityLogger } = await import('./activity_logger.js');
				const { generateReportFromLogFile } = await import('./metrics_analyzer.js');
				
				const currentLogFile = activityLogger.getCurrentLogFile();
				const report = await generateReportFromLogFile(currentLogFile);
				
				// Create a new document with the report
				const document = await vscode.workspace.openTextDocument({
					content: report,
					language: 'markdown'
				});
				await vscode.window.showTextDocument(document);
				
				vscode.window.showInformationMessage('Metrics analysis completed! Check the report.');
				
			} catch (error) {
				vscode.window.showErrorMessage(`Failed to analyze metrics: ${error}`);
			}
		})
	);

	// Add command to toggle backspace earcon
	context.subscriptions.push(
		vscode.commands.registerCommand('lipcoder.toggleBackspaceEarcon', async () => {
			try {
				config.backspaceEarconEnabled = !config.backspaceEarconEnabled;
				const status = config.backspaceEarconEnabled ? 'enabled' : 'disabled';
				vscode.window.showInformationMessage(`Backspace earcon ${status}`);
				log(`[Extension] Backspace earcon ${status}`);
			} catch (error) {
				vscode.window.showErrorMessage(`Failed to toggle backspace earcon: ${error}`);
			}
		})
	);

	// Set up cursor movement tracking
	let lastCursorPosition: { file: string; line: number; character: number } | null = null;
	
	context.subscriptions.push(
		vscode.window.onDidChangeTextEditorSelection((event) => {
			const editor = event.textEditor;
			if (!editor || editor.document.uri.scheme !== 'file') {
				return;
			}

			const currentPosition = {
				file: editor.document.fileName,
				line: event.selections[0].active.line,
				character: event.selections[0].active.character
			};

			// Only log if position actually changed
			if (!lastCursorPosition || 
				lastCursorPosition.file !== currentPosition.file ||
				lastCursorPosition.line !== currentPosition.line ||
				lastCursorPosition.character !== currentPosition.character) {
				
				const { logCursorMovement } = require('./activity_logger');
				logCursorMovement(
					currentPosition.file,
					currentPosition.line,
					currentPosition.character,
					lastCursorPosition?.line,
					lastCursorPosition?.character
				);

				lastCursorPosition = currentPosition;
			}
		})
	);

	// Track file opening/closing and navigation
	let lastActiveFile: string | null = null;
	
	context.subscriptions.push(
		vscode.workspace.onDidOpenTextDocument((document) => {
			if (document.uri.scheme === 'file') {
				const { logFileOperation, logNavigation } = require('./activity_logger');
				logFileOperation('file_opened', document.fileName, {
					languageId: document.languageId,
					lineCount: document.lineCount
				});
				
				// Track navigation if this is a different file
				if (lastActiveFile && lastActiveFile !== document.fileName) {
					logNavigation(lastActiveFile, document.fileName, 'file_switch');
				}
				lastActiveFile = document.fileName;
			}
		})
	);

	context.subscriptions.push(
		vscode.workspace.onDidCloseTextDocument((document) => {
			if (document.uri.scheme === 'file') {
				const { logFileOperation } = require('./activity_logger');
				logFileOperation('file_closed', document.fileName);
			}
		})
	);

	// Track active editor changes for navigation
	context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor((editor) => {
			if (editor && editor.document.uri.scheme === 'file') {
				const currentFile = editor.document.fileName;
				if (lastActiveFile && lastActiveFile !== currentFile) {
					const { logNavigation } = require('./activity_logger');
					logNavigation(lastActiveFile, currentFile, 'editor_switch');
				}
				lastActiveFile = currentFile;
			}
		})
	);

	// Initialize comprehensive event tracking
	try {
		comprehensiveEventTracker.initialize(context);
		logSuccess('✅ Comprehensive event tracking initialized');
	} catch (error) {
		logError(`❌ Failed to initialize comprehensive event tracking: ${error}`);
	}

	// Log extension activation
	logExtensionLifecycle('activate', {
		version: context.extension.packageJSON.version,
		extensionId: context.extension.id,
		activationTime: Date.now() - activationStartTime
	});

	logSuccess("🎉 lipcoder extension activated successfully with comprehensive logging!");
	logMemory(`[Memory] Post-activation: Heap: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)}MB, RSS: ${(process.memoryUsage().rss / 1024 / 1024).toFixed(2)}MB`);

}

export async function deactivate() {
	logWarning("🔄 lipcoder deactivate starting...");
	
	// Clear the activation flag to allow clean reactivation
	(global as any).__lipcoderActivated = false;
	
	// Create a force exit timeout as absolute last resort
	const forceExitTimer = setTimeout(() => {
		logError("💀 FORCE EXIT: Extension deactivation took too long, forcing process exit");
		// Try graceful exit first
		try {
			process.exit(0);
		} catch {
			// If that fails, force kill
			process.kill(process.pid, 'SIGKILL');
		}
	}, 8000); // 8 second timeout
	
	try {
		// Log extension deactivation
		logExtensionLifecycle('deactivate', {
			deactivationStartTime: Date.now()
		});

		// Dispose comprehensive event tracker first
		try {
			comprehensiveEventTracker.dispose();
			logSuccess('✅ Comprehensive event tracker disposed');
		} catch (error) {
			logError(`❌ Failed to dispose comprehensive event tracker: ${error}`);
		}

		// Dispose activity logger
		try {
			await activityLogger.dispose();
			logSuccess('✅ Activity logger disposed');
		} catch (error) {
			logError(`❌ Failed to dispose activity logger: ${error}`);
		}

		// Stop memory monitoring
		stopMemoryMonitoring();
		
		// Clean up conversational ASR system
		try {
			const { disposeConversationalPopup } = await import('./conversational_popup.js');
			disposeConversationalPopup();
			logSuccess('✅ Conversational ASR system disposed');
		} catch (error) {
			logError(`❌ Failed to dispose conversational ASR system: ${error}`);
		}
	
	// Stop all servers
	try {
		await serverManager.stopServers();
		logSuccess('✅ All servers stopped');
	} catch (error) {
		logError(`❌ Failed to stop servers: ${error}`);
	}
		
		// Dispose all VS Code subscriptions immediately
		try {
			const context = (global as any).lipcoderContext;
			if (context && context.subscriptions) {
				logWarning(`🧹 Disposing ${context.subscriptions.length} VS Code subscriptions...`);
				context.subscriptions.forEach((disposable: vscode.Disposable) => {
					try {
						disposable.dispose();
					} catch (err) {
						// Ignore disposal errors
					}
				});
				context.subscriptions.length = 0; // Clear array
				logSuccess('✅ All VS Code subscriptions disposed');
			}
		} catch (err) {
			logError(`❌ Failed to dispose VS Code subscriptions: ${err}`);
		}
		
		// Force stop all audio immediately
		try {
			const { stopPlayback, cleanupAudioResources } = require('./audio');
			stopPlayback();
			cleanupAudioResources();
			logSuccess('✅ Audio resources cleaned up');
		} catch (err) {
			logError(`❌ Failed to cleanup audio: ${err}`);
		}
		
		// Aggressive language client cleanup
		try {
			const { emergencyStopLanguageClient } = require('./language_client');
			emergencyStopLanguageClient();
			logSuccess('✅ Language client stopped');
		} catch (err) {
			logError(`❌ Failed to cleanup language client: ${err}`);
		}
		
		// Clean up Enhanced Push-to-Talk ASR client
		try {
			const enhancedASRModule = require('./features/enhanced_push_to_talk_asr');
			// Enhanced ASR has its own cleanup function
			if (typeof enhancedASRModule.cleanupASRResources === 'function') {
				enhancedASRModule.cleanupASRResources();
				logSuccess('✅ Enhanced Push-to-Talk ASR cleaned up');
			}
		} catch (err) {
			logError(`❌ Failed to cleanup Enhanced Push-to-Talk ASR: ${err}`);
		}
		
		// Clean up speed optimizers
		try {
			const { disposeASROptimizer } = require('./features/asr_speed_optimizer');
			const { disposeLLMOptimizer } = require('./features/llm_speed_optimizer');
			disposeASROptimizer();
			disposeLLMOptimizer();
			logSuccess('✅ Speed optimizers cleaned up');
		} catch (err) {
			logError(`❌ Failed to cleanup speed optimizers: ${err}`);
		}
		
		// Clean up LLM resources
		try {
			const { cleanupLLMResources } = require('./llm');
			cleanupLLMResources();
			logSuccess('✅ LLM resources cleaned up');
		} catch (err) {
			logError(`❌ Failed to cleanup LLM: ${err}`);
		}
		
		// Clean up all preloaded caches
		try {
			const { cleanupPreloadedCaches } = require('./preload');
			cleanupPreloadedCaches();
			logSuccess('✅ Preloaded caches cleaned up');
		} catch (err) {
			logError(`❌ Failed to cleanup preloaded caches: ${err}`);
		}
		
		// Force garbage collection
		if (global.gc) {
			try {
				global.gc();
				logSuccess('🗑️ Forced garbage collection');
			} catch (err) {
				logError(`❌ Failed to force GC: ${err}`);
			}
		}
		
		// Clear the force exit timeout
		clearTimeout(forceExitTimer);
		
		// Final memory report
		const finalMemory = process.memoryUsage();
		logMemory(`[Memory] Final: Heap: ${(finalMemory.heapUsed / 1024 / 1024).toFixed(2)}MB, RSS: ${(finalMemory.rss / 1024 / 1024).toFixed(2)}MB`);
		
		logSuccess("✅ lipcoder deactivation complete");
		
	} catch (error) {
		logError(`💥 Critical error during deactivation: ${error}`);
		clearTimeout(forceExitTimer);
		
		// If deactivation fails completely, force exit immediately
		logError("💀 Deactivation failed, forcing immediate exit");
		setTimeout(() => process.exit(0), 100);
	}
}