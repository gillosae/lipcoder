# Terminal Test Guide

## ✅ node-pty Fixed!

The native module `pty.node` has been successfully compiled and is now available at:
- `node_modules/node-pty/build/Release/pty.node` (61,592 bytes)
- `node_modules/node-pty/bin/darwin-arm64-132/node-pty.node` (precompiled)

## Quick Test Steps

### 1. Test Terminal Opening
1. Press `Cmd+Shift+P` to open Command Palette
2. Type "LipCoder: Open Pseudo Terminal"
3. **Expected**: Should see "node-pty loaded successfully" in logs
4. **Expected**: Terminal opens with full PTY functionality

### 2. Test Audio Navigation
1. In the opened terminal, type some commands:
   ```bash
   ls -la
   echo "Hello World"
   pwd
   ```

2. Try navigation with **ARROW KEYS** (directly in LipCoder terminal):
   - **↑ (Up Arrow)** - Navigate to previous line and speak it + shows "📍 Line X/Y"
   - **↓ (Down Arrow)** - Navigate to next line and speak it + shows "📍 Line X/Y"
   - **← (Left Arrow)** - Move left and speak character + shows "👈 Char X: [text]"
   - **→ (Right Arrow)** - Move right and speak character + shows "👉 Char X: [text]"

3. Alternative: Use Command Palette:
   - "LipCoder: Terminal Next Line" - should speak terminal output
   - "LipCoder: Terminal Previous Line" - should navigate backward
   - "LipCoder: Terminal Character Left/Right" - should speak individual characters

### 3. Test Input Echo
1. Type characters in the terminal
2. **Expected**: Each character should be spoken through TTS as you type

### 4. Verify Full PTY Mode
- Terminal name should be "LipCoder" (not "LipCoder Terminal (Fallback)")
- Should see successful node-pty loading message
- All terminal output should be automatically captured for navigation

## Troubleshooting

If you still see fallback mode:
1. Restart VS Code completely
2. Reload the extension window
3. Check the Output panel for any remaining errors

## Keyboard Shortcuts

| Key | Action | Context |
|-----|--------|---------|
| `Ctrl+Shift+T` | Open LipCoder Terminal | Global |
| `↑` (Up) | **Navigate to previous line** (overrides command history) | LipCoder Terminal |
| `↓` (Down) | **Navigate to next line** (overrides command history) | LipCoder Terminal |
| `←` (Left) | **Character left** (overrides cursor movement) | LipCoder Terminal |
| `→` (Right) | **Character right** (overrides cursor movement) | LipCoder Terminal |

**Important**: Arrow keys now work directly in the LipCoder terminal and override the default terminal behavior (command history and cursor movement). This ensures your navigation always works for audio feedback.

## Success Indicators

✅ **"node-pty loaded successfully"** message in logs  
✅ Terminal opens without fallback warnings  
✅ Audio navigation works through all terminal output  
✅ **Arrow keys navigate and speak terminal content**  
✅ **Visual indicators show current position** (📍 for lines, 👈👉 for characters)
✅ Character-by-character input echo with TTS  
✅ Full PTY shell interaction  

The terminal should now have full accessibility features with both audio and visual feedback! 