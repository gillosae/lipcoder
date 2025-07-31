# Voice Command Router with LLM Intelligence

The Voice Command Router allows you to execute VS Code commands using **natural speech** instead of just inserting text. When you use ASR recording (Ctrl+Shift+A), the transcribed text is processed by an **LLM (GPT-4o-mini)** for intelligent command matching, making voice control much more flexible and natural.

## How It Works

1. **Start Recording**: Press `Ctrl+Shift+A` to start recording (captures current editor context)
2. **Record Speech**: Speak your command while recording is active
3. **Stop Recording**: Press `Ctrl+Shift+A` again to stop recording and process speech
4. **Speech Processing**: Whisper transcribes your speech to text
5. **LLM Command Matching**: GPT-4o-mini intelligently interprets your natural speech to find matching commands
6. **Editor Context**: Commands execute in the editor where recording started
7. **Fallback Matching**: If LLM doesn't find a match, exact pattern matching is used
8. **Command Execution**: The matched VS Code command is executed in the original editor context
9. **Text Fallback**: If no command matches, the text is inserted at the original cursor position

## 🧠 LLM-Powered Natural Language Understanding

The system now uses **GPT-4o-mini** to understand natural variations of commands:

- **"save this file"** → Matches "save file" command
- **"can you save"** → Matches "save file" command  
- **"format my code"** → Matches "format document" command
- **"show me the sidebar"** → Matches "toggle sidebar" command
- **"please open a terminal"** → Matches "open terminal" command
- **"I want to find something"** → Matches "find" command

## 🎙️ Push-to-Talk Behavior & Context Tracking

### True Push-to-Talk
- **Press `Ctrl+Shift+A`** to **start** recording
- **Press `Ctrl+Shift+A` again** to **stop** recording and process speech
- **Auto-stop**: Recording automatically stops after 30 seconds as a safety measure
- **Visual Feedback**: Status bar shows recording state and instructions

### Editor Context Preservation
- **Context Capture**: When you start recording, the system captures:
  - Current active editor
  - Cursor position
  - Text selection
  - Document path
- **Context Execution**: All commands execute in the original editor context, even if you switch editors during recording
- **Smart Navigation**: Line numbers and function searches work in the context where recording started

### Status Bar Integration
- **Ready State**: `$(mic) ASR Ready - Press Ctrl+Shift+A to record`
- **Recording State**: `$(record) Recording... Press Ctrl+Shift+A to stop`
- **Tooltip Help**: Hover over status bar for usage instructions

## 🚀 New Advanced Features

### Line Navigation with Parameters
- **Direct Line Access**: Say "go to line 25" to jump directly to line 25
- **Dialog Fallback**: Say "go to line" to open the go-to-line dialog

### LLM-Powered Function Search  
- **Intelligent Function Finding**: Say "go to function handleClick" and the LLM will scan your code to find the function
- **Natural Language**: Works with variations like "find function", "navigate to function"
- **Context Awareness**: LLM understands your code structure regardless of language

### Package.json Script Execution
- **Voice-Activated Scripts**: Say "run build" to execute `npm run build`
- **Smart Matching**: LLM matches natural language to script names
- **Auto-Discovery**: Automatically reads scripts from your package.json
- **Terminal Integration**: Opens terminal and runs the script with full output

## Built-in Command Patterns

### File Operations
- **"open file"** or **"file open"** → Opens the quick file picker
- **"save file"** or **"save"** → Saves the current file
- **"new file"** or **"create file"** → Creates a new untitled file

### Navigation
- **"go to line"** or **"goto line"** → Opens the go-to-line dialog
- **"go to line 25"** or **"goto line 25"** → Goes directly to line 25
- **"find"** or **"search"** → Opens the find dialog
- **"replace"** or **"find and replace"** → Opens find and replace

### 🧠 Advanced LLM-Powered Navigation
- **"go to function handleClick"** → Uses LLM to find and navigate to the `handleClick` function
- **"find function submitForm"** → Finds and jumps to the `submitForm` function
- **"navigate to function main"** → Locates and navigates to the `main` function

### Editor Commands
- **"comment line"** or **"comment"** → Toggles line comment
- **"format document"** or **"format"** → Formats the current document
- **"select all"** → Selects all text
- **"copy"** or **"copy line"** → Copies selection or line
- **"paste"** → Pastes from clipboard
- **"undo"** → Undoes last action
- **"redo"** → Redoes last action

### Terminal
- **"open terminal"** or **"terminal"** → Opens a new terminal

### View Commands
- **"toggle sidebar"** or **"sidebar"** → Toggles sidebar visibility
- **"command palette"** or **"commands"** → Opens command palette

### Code Actions
- **"quick fix"** or **"fix"** → Shows quick fixes
- **"rename symbol"** or **"rename"** → Renames symbol
- **"go to definition"** or **"definition"** → Goes to definition

### Text Insertion
- **"new line"** or **"line break"** → Inserts a new line
- **"tab"** or **"indent"** → Inserts tab/indent

### 📦 Package.json Script Execution
- **"run build"** → Executes `npm run build`
- **"run test"** → Executes `npm run test`  
- **"start the server"** → Executes `npm run start`
- **"execute script dev"** → Executes `npm run dev`
- **"run the watch script"** → Finds and runs watch-related scripts

## Management Commands

### Show Available Patterns
Run the command `LipCoder: Show Available Voice Command Patterns` to see all registered patterns.

### Toggle Command Router
Run `LipCoder: Toggle Voice Command Router` to enable/disable command processing. When disabled, all speech will be inserted as text.

### Toggle LLM Matching
Run `LipCoder: Toggle LLM Command Matching` to enable/disable intelligent LLM-based command interpretation. When disabled, only exact pattern matching is used.

### Add Custom Patterns
Run `LipCoder: Add Custom Voice Command Pattern` to add your own voice commands:

1. Enter the speech pattern to match (e.g., "close file")
2. Enter the VS Code command to execute (e.g., "workbench.action.closeActiveEditor")
3. Optionally enter a description

### Manual Advanced Commands
- **`LipCoder: Go to Function (Voice)`** - Manually enter a function name to navigate to
- **`LipCoder: Run Package.json Script (Voice)`** - Manually select and run an npm script

## ✨ Advantages of LLM Matching

- **Natural Speech**: Speak naturally without memorizing exact phrases
- **Contextual Understanding**: The LLM understands intent, not just keywords
- **Flexible Phrasing**: Multiple ways to express the same command
- **Intelligent Fallback**: Exact pattern matching as backup ensures reliability
- **Continuous Learning**: The LLM adapts to various speech patterns

## Usage Tips

1. **Speak Naturally**: With LLM matching, you can use natural conversational phrases
2. **Be Clear**: While flexible, clear speech still helps with accuracy
3. **Fallback Reliability**: If LLM fails, exact pattern matching provides backup
4. **Custom Commands**: Add patterns for any VS Code command you use frequently
5. **Testing**: Use "Show Available Voice Command Patterns" to see what's available
6. **Toggle Options**: Disable LLM matching if you prefer exact pattern matching

## Examples

### Natural Language Examples (Push-to-Talk)
1. **Position cursor** in the editor where you want the command to execute
2. **Press `Ctrl+Shift+A`** to start recording (captures current editor context)
3. **Speak your command**:
   - **"can you save this for me?"** → Executes save command
   - **"I need to format this code"** → Executes format document in the original editor
   - **"show me the file browser"** → Toggles sidebar
   - **"take me to line 42"** → Goes to line 42 in the original editor
   - **"find the handleSubmit function"** → Searches for function in the original editor
   - **"please run the build script"** → Executes `npm run build`
4. **Press `Ctrl+Shift+A` again** to stop recording and process the command
5. **Command executes** in the original editor context, even if you switched files

### Exact Pattern Examples (Fallback)
1. Press `Ctrl+Shift+A`
2. Say "save file" → Executes save command
3. Say "format document" → Formats the document

### Custom Command Example
1. Run "Add Custom Voice Command Pattern"
2. Pattern: "close tab"
3. Command: "workbench.action.closeActiveEditor"
4. Description: "Close current tab"
5. Now you can say "close tab" to close the current editor

## Configuration

The command router is enabled by default with the following settings:
- **Show Notifications**: Shows success messages when commands execute
- **Enable Logging**: Logs command executions to the output channel
- **Fallback to Text**: Inserts text when no command matches
- **LLM Matching**: Uses GPT-4o-mini for intelligent command interpretation
- **API Key Required**: Uses your OpenAI API key from VS Code settings

## Troubleshooting

### Recording Issues
- **Recording not starting**: Ensure you're in an editor (not just VS Code) when pressing `Ctrl+Shift+A`
- **Recording not stopping**: Press `Ctrl+Shift+A` again, or wait for 30-second auto-stop
- **No visual feedback**: Check the status bar at the bottom for recording indicators

### Command Execution Issues  
- **Commands not working**: Check the Output channel "LipCoder Enhanced ASR" for logs
- **Commands executing in wrong file**: Commands execute in the editor where recording started
- **Line numbers wrong**: Line navigation uses the editor context from when recording began
- **Function not found**: Function search looks in the file that was active when recording started

### API and Configuration
- **OpenAI API errors**: Ensure your API key is set in VS Code settings (`lipcoder.openaiApiKey`)
- **LLM not understanding**: Try speaking more clearly or use exact pattern phrases
- **Want exact matching only**: Run "Toggle LLM Command Matching" to disable LLM interpretation
- **Custom commands failing**: Verify the VS Code command name is correct

### General
- **Want text instead of commands**: Toggle the command router off completely
- **Keybinding conflicts**: Check VS Code keybinding settings for conflicts with `Ctrl+Shift+A`

## Technical Details

### Core Architecture
- **LLM Integration**: Uses GPT-4o-mini for intelligent natural language command interpretation
- **Push-to-Talk Implementation**: Context-aware keybinding system with VS Code context keys
- **Editor Context Preservation**: Captures and maintains editor state across recording sessions
- **Auto-stop Safety**: 30-second maximum recording duration with cleanup timers

### Advanced Features
- **Advanced Function Search**: LLM analyzes code structure to locate functions by name
- **Package.json Integration**: Automatically reads and executes npm scripts from workspace
- **Parameterized Commands**: Extracts parameters like line numbers and function names from speech
- **Custom Handlers**: Advanced commands use custom logic for complex operations
- **Context-Aware Execution**: Commands execute in the original editor with preserved cursor position

### Processing Pipeline
- **Dual Matching**: Primary LLM matching with exact pattern matching as fallback
- **Command Patterns**: Support string matching, regex patterns, and parameter extraction
- **Processing Order**: Context capture → LLM matching → Pattern matching → Script matching → Text insertion
- **Context Keys**: Uses VS Code context system for dynamic keybinding behavior

### Integration & Performance
- **API Usage**: Minimal token usage with focused prompts for cost efficiency
- **Error Handling**: Failed command executions gracefully fall back to text insertion
- **VS Code Integration**: All VS Code commands supported through the command API
- **Status Bar Integration**: Real-time feedback with contextual tooltips and visual indicators 