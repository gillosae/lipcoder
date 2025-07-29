# LipCoder Terminal Setup

## Overview

LipCoder provides a pseudoterminal implementation with audio navigation features. The terminal supports both a full-featured PTY mode (using `node-pty`) and a fallback mode for basic functionality.

## Features

### 1. Terminal Creation
- **Command**: `lipcoder.openTerminal`
- **Description**: Opens a LipCoder terminal with audio feedback
- **Access**: Command Palette → "LipCoder: Open Pseudo Terminal"

### 2. Navigation Commands
- **Next Line**: `lipcoder.terminalNextLine` - Navigate to and speak the next terminal line
- **Previous Line**: `lipcoder.terminalPrevLine` - Navigate to and speak the previous terminal line  
- **Character Left**: `lipcoder.terminalCharLeft` - Move cursor left and speak character
- **Character Right**: `lipcoder.terminalCharRight` - Move cursor right and speak character

### 3. Manual Output Addition
- **Command**: `lipcoder.addTerminalOutput`
- **Description**: Manually add terminal output for navigation (useful in fallback mode)

## Technical Implementation

### Full PTY Mode (Preferred)
When `node-pty` is available:
- Creates a real pseudoterminal with shell interaction
- Captures all terminal output automatically
- Provides character-by-character input echo with TTS
- Buffers output lines for navigation

### Fallback Mode
When `node-pty` is not available:
- Uses VS Code's built-in terminal API
- Limited automatic output capture
- Manual output addition via `addTerminalOutput` command
- Basic navigation functionality

## Setup Instructions

### 1. Install Dependencies
```bash
cd client
npm install
```

### 2. Rebuild Native Modules
```bash
# From project root
npx electron-rebuild
```

### 3. Build Extension
```bash
npm run build
```

## Testing the Terminal

### 1. Test Basic Terminal Opening
1. Open Command Palette (`Cmd+Shift+P`)
2. Run "LipCoder: Open Pseudo Terminal"
3. Verify terminal opens and shows appropriate mode message

### 2. Test Navigation Commands  
1. Type some commands in the terminal to generate output
2. Use the navigation commands:
   - "LipCoder: Terminal Next Line"
   - "LipCoder: Terminal Previous Line"
   - "LipCoder: Terminal Character Left"
   - "LipCoder: Terminal Character Right"

### 3. Test Manual Output Addition (if in fallback mode)
1. Run "LipCoder: Add Terminal Output for Navigation"
2. Enter some test text
3. Use navigation commands to browse the added output

## Troubleshooting

### node-pty Issues
If you see "Using fallback mode due to node-pty error":

1. **Rebuild for Electron**:
   ```bash
   npx electron-rebuild
   ```

2. **Manual rebuild** (if needed):
   ```bash
   npm rebuild node-pty --runtime=electron --target=$(node -p "process.versions.electron") --disturl=https://atom.io/download/electron
   ```

3. **Check Compiler Tools**:
   - macOS: Install Xcode Command Line Tools
   - Windows: Install Visual Studio Build Tools
   - Linux: Install build-essential

### Common Issues

1. **"No terminal output to navigate"**: 
   - In fallback mode, use `addTerminalOutput` to manually add content
   - In PTY mode, run some commands to generate output first

2. **Terminal commands not found**:
   - Ensure the extension is built: `npm run build`
   - Restart VS Code after building

3. **Audio not working**:
   - Check that TTS servers are running
   - Verify audio dependencies are installed

## Status Indicators

- **"node-pty loaded successfully"**: Full PTY mode active
- **"Using fallback mode"**: Limited functionality, consider fixing node-pty
- **"LipCoder Terminal (Fallback)"**: Terminal name indicates fallback mode

## Command Summary

| Command | Function | Mode |
|---------|----------|------|
| `lipcoder.openTerminal` | Open terminal | Both |
| `lipcoder.terminalNextLine` | Navigate next line | Both |
| `lipcoder.terminalPrevLine` | Navigate previous line | Both |
| `lipcoder.terminalCharLeft` | Move left, speak char | Both |
| `lipcoder.terminalCharRight` | Move right, speak char | Both |
| `lipcoder.addTerminalOutput` | Add output manually | Both |

The terminal implementation provides a foundation for accessible terminal interaction with audio feedback, automatically falling back to basic functionality when full PTY support is not available. 