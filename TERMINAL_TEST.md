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

3. Alternative: Use Command Palette (also with earcons):
   - "LipCoder: Terminal Next Line" - plays `indent_2.pcm` + speaks terminal output
   - "LipCoder: Terminal Previous Line" - plays `indent_1.pcm` + navigates backward  
   - "LipCoder: Terminal Character Left" - plays `comma.pcm` + speaks individual characters
   - "LipCoder: Terminal Character Right" - plays `dot.pcm` + speaks individual characters

4. Test Manual Output Addition:
   - "LipCoder: Add Terminal Output for Navigation" - plays `enter.pcm` + confirmation message

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
✅ **Enhanced audio navigation with TTS and earcons**  
✅ **Arrow keys navigate with distinct audio feedback**  
✅ **Visual cursor positioning with highlighting**  
✅ **All TTS uses no category (undefined) for clean speech**  
✅ **Distinct earcons for different navigation types:**
   - `indent_1.pcm` for up navigation
   - `indent_2.pcm` for down navigation  
   - `comma.pcm` for left character navigation
   - `dot.pcm` for right character navigation
   - `enter.pcm` for confirmations
✅ Character-by-character input echo with TTS (no category)  
✅ Full PTY shell interaction with rich audio feedback

The terminal now has **editor-like accessibility** with comprehensive TTS and earcon integration! 