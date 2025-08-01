# Vibe Coding Feature

The Vibe Coding feature allows you to modify code using natural language instructions. It integrates with OpenAI's GPT-4 to understand your requests and apply changes to your code.

## How to Use

### Method 1: Command Palette
1. Open the Command Palette (`Ctrl+Shift+P` or `Cmd+Shift+P`)
2. Type "Vibe Coding: Modify Code with Natural Language"
3. Press Enter
4. Enter your natural language instruction in the popup

### Method 2: Keyboard Shortcut
1. Make sure you have a file open in the editor
2. Press `Ctrl+Shift+V` (or `Cmd+Shift+V` on macOS)
3. Enter your natural language instruction in the popup

## Examples

Here are some example instructions you can try:

- **"Add error handling to this function"**
- **"Convert this to use async/await"**
- **"Add JSDoc comments to this function"**
- **"Refactor this to use a more descriptive variable name"**
- **"Add input validation to this function"**
- **"Convert this to TypeScript"**

## How It Works

1. **Input**: You provide a natural language description of what you want to change
2. **Processing**: The system sends your code and instruction to OpenAI's GPT-4
3. **Analysis**: The AI analyzes your request and generates modified code
4. **Review**: You see a summary of the changes with line counts (+15, -21, etc.)
5. **Apply**: You can choose to apply the changes or cancel

## Features

- **Smart Diff**: Shows exactly what lines were added, removed, or modified
- **Line Counts**: Displays summary like "+15, -21" for quick overview
- **Natural Language Summary**: Explains changes in plain English
- **Audio Feedback**: Uses your existing audio system to provide feedback
- **Safe**: Always shows you the changes before applying them

## Requirements

- OpenAI API key configured in settings (`lipcoder.openaiApiKey`)
- Active text editor with code to modify

## Tips

- Be specific in your instructions for better results
- You can select specific code before running the command to focus on that section
- The feature works best with well-structured code
- If the AI doesn't understand your request, it will return the original code unchanged 