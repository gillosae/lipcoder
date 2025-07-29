# Voice Command Router with LLM Intelligence

The Voice Command Router allows you to execute VS Code commands using **natural speech** instead of just inserting text. When you use ASR recording (Ctrl+Shift+A), the transcribed text is processed by an **LLM (GPT-4o-mini)** for intelligent command matching, making voice control much more flexible and natural.

## How It Works

1. **Record Speech**: Press `Ctrl+Shift+A` to start/stop recording
2. **Speech Processing**: Whisper transcribes your speech to text
3. **LLM Command Matching**: GPT-4o-mini intelligently interprets your natural speech to find matching commands
4. **Fallback Matching**: If LLM doesn't find a match, exact pattern matching is used
5. **Command Execution**: The matched VS Code command is executed
6. **Text Fallback**: If no command matches, the text is inserted normally

## 🧠 LLM-Powered Natural Language Understanding

The system now uses **GPT-4o-mini** to understand natural variations of commands:

- **"save this file"** → Matches "save file" command
- **"can you save"** → Matches "save file" command  
- **"format my code"** → Matches "format document" command
- **"show me the sidebar"** → Matches "toggle sidebar" command
- **"please open a terminal"** → Matches "open terminal" command
- **"I want to find something"** → Matches "find" command

## Built-in Command Patterns

### File Operations
- **"open file"** or **"file open"** → Opens the quick file picker
- **"save file"** or **"save"** → Saves the current file
- **"new file"** or **"create file"** → Creates a new untitled file

### Navigation
- **"go to line"** or **"goto line"** → Opens the go-to-line dialog
- **"find"** or **"search"** → Opens the find dialog
- **"replace"** or **"find and replace"** → Opens find and replace

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

### Natural Language Examples (LLM Matching)
1. Press `Ctrl+Shift+A`
2. Say **"can you save this for me?"** → Executes save command
3. Say **"I need to format this code"** → Executes format document
4. Say **"show me the file browser"** → Toggles sidebar
5. Say **"let me search for something"** → Opens find dialog

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

- **Ctrl+Shift+A not working**: The keybinding has been fixed - restart VS Code if needed
- **Commands not working**: Check the Output channel "LipCoder Enhanced ASR" for logs
- **LLM not understanding**: Try speaking more clearly or use exact pattern phrases
- **OpenAI API errors**: Ensure your API key is set in VS Code settings (`lipcoder.openaiApiKey`)
- **Want exact matching only**: Run "Toggle LLM Command Matching" to disable LLM interpretation
- **Custom commands failing**: Verify the VS Code command name is correct
- **Want text instead of commands**: Toggle the command router off completely

## Technical Details

- **LLM Integration**: Uses GPT-4o-mini for intelligent natural language command interpretation
- **Dual Matching**: Primary LLM matching with exact pattern matching as fallback
- **Command Patterns**: Support both string matching and regex patterns  
- **Processing Order**: LLM matching → Pattern matching → Text insertion
- **API Usage**: Minimal token usage with focused prompts for cost efficiency
- **Error Handling**: Failed command executions gracefully fall back to text insertion
- **VS Code Integration**: All VS Code commands supported through the command API 