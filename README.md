# LipCoder (Working)

**Audio-Enhanced Coding Assistant for Visual Studio Code**

LipCoder transforms your coding experience with intelligent audio feedback, making code navigation and editing accessible through sound. Designed for developers who benefit from audio-first interfaces, LipCoder provides rich auditory feedback for code structure, navigation, and real-time editing.

## ✨ Features

### 🎵 **Smart Audio Feedback**
- **Text-to-Speech (TTS)**: Hear your code read aloud with context-aware pronunciation
- **Earcons**: Distinctive audio cues for brackets, punctuation, and code structures
- **Stereo Panning**: Spatial audio positioning based on cursor location and code indentation
- **Multi-Voice Support**: Different voices for variables, keywords, literals, and comments

### 🎯 **Intelligent Code Navigation**
- **Token-Based Reading**: Code is parsed and spoken by semantic meaning
- **Indentation Audio Cues**: Hear nesting levels through audio feedback
- **Function Navigation**: Audio-guided browsing of functions and symbols
- **File Tree Navigation**: Audio feedback for project structure exploration

### 🎤 **Speech Recognition (ASR)**
- **Push-to-Talk**: Voice input for hands-free coding
- **Toggle ASR**: Enable/disable speech recognition with keyboard shortcuts
- **Real-time Transcription**: Convert speech to text with high accuracy

### 🎧 **Advanced Audio Features**
- **Global Panning System**: Audio positioning reflects code structure
- **Customizable Playback**: Adjustable speed and voice settings
- **Audio Caching**: Optimized performance with intelligent caching
- **Multiple Audio Formats**: Support for PCM and WAV audio files

## 🚀 Installation

1. **Install the Extension**
   ```bash
   # From VS Code marketplace (when published)
   # Or install from VSIX file
   ```

2. **Install Dependencies**
   ```bash
   # Install Python dependencies for TTS/ASR
   pip install torch torchaudio
   pip install silero-tts
   pip install pydub
   
   # Install system audio tools (macOS)
   brew install ffmpeg sox
   ```

3. **Download Audio Models**
   ```bash
   # Run the setup script
   npm run setup
   ```

## ⚙️ Configuration

LipCoder can be customized through VS Code settings:

```json
{
    "lipcoder.tts.enabled": true,
    "lipcoder.tts.speed": 1.4,
    "lipcoder.audio.panningEnabled": true,
    "lipcoder.audio.globalPanningEnabled": true,
    "lipcoder.asr.enabled": true,
    "lipcoder.voices.variable": "en_3",
    "lipcoder.voices.keyword": "en_35",
    "lipcoder.voices.literal": "en_5"
}
```

## 📝 Usage

### Basic Commands

| Command | Shortcut | Description |
|---------|----------|-------------|
| `LipCoder: Toggle Audio Panning` | - | Enable/disable stereo panning |
| `LipCoder: Toggle ASR` | - | Enable/disable speech recognition |
| `LipCoder: Push to Talk Start` | `Cmd+Shift+R` | Start voice input |
| `LipCoder: Push to Talk Stop` | `Cmd+Shift+S` | Stop voice input |

### Audio Feedback

- **Typing**: Hear letters, numbers, and symbols as you type
- **Navigation**: Audio cues when moving through code
- **Selection**: Hear selected text read aloud
- **Indentation**: Audio feedback for code nesting levels
- **Errors**: Different audio cues for syntax errors and warnings

### Language Support

Currently supports audio feedback for:
- **Python**: Keywords, functions, variables, literals
- **TypeScript/JavaScript**: Language constructs and syntax
- **Generic**: Punctuation, brackets, and common programming symbols

## 🛠️ Technical Requirements

### System Requirements
- **Operating System**: macOS (primary), Linux, Windows
- **VS Code**: Version 1.80.0 or higher
- **Node.js**: Version 16.0 or higher
- **Python**: Version 3.8 or higher

### Audio Requirements
- **Audio Output**: Stereo speakers or headphones (recommended for panning)
- **Microphone**: Required for ASR/Push-to-Talk features
- **Audio Formats**: PCM, WAV support
- **Sample Rates**: 24kHz, 48kHz support

### Performance Notes
- **Memory Usage**: ~50-100MB for audio caches
- **CPU Usage**: Moderate during TTS generation
- **Disk Space**: ~500MB for audio models and caches

## 🎛️ Architecture

### Audio Pipeline
```
Code Input → Token Parser → TTS Engine → Audio Processing → Stereo Output
          ↓
    Earcon System → PCM Audio → Panning System → Speaker Output
```

### Components
- **TTS Engine**: Silero neural TTS models
- **ASR Engine**: Real-time speech recognition
- **Audio Processor**: Stereo panning and effects
- **Cache System**: Optimized audio file management

## 🔧 Development

### Setup Development Environment
```bash
# Clone repository
git clone <repository-url>
cd lipcoder

# Install dependencies
npm install
cd client && npm install
cd ../server && npm install

# Build extension
npm run build

# Run in development
code --extensionDevelopmentPath=.
```

### Audio File Management
```bash
# Convert audio files to PCM format
python client/convert_mono_to_stereo.py

# Clear audio caches
python client/clear_audio_cache.py
```

## 🐛 Known Issues

- **macOS Only**: Primary testing on macOS; limited Windows/Linux testing
- **Audio Latency**: Minor delays in TTS generation for complex code
- **Memory Usage**: Large audio caches may consume significant memory
- **Model Loading**: Initial TTS model download can be slow

## 🚧 Roadmap

- [ ] **Multi-Language Support**: Additional programming languages
- [ ] **Custom Voice Training**: User-specific voice models  
- [ ] **Advanced ASR**: Code-specific speech recognition
- [ ] **Cloud TTS**: Optional cloud-based TTS engines
- [ ] **Collaborative Audio**: Multi-user audio feedback
- [ ] **Mobile Support**: Extension for mobile development

## 🤝 Contributing

We welcome contributions! Please see our contributing guidelines:

1. **Fork the repository**
2. **Create a feature branch**: `git checkout -b feature/amazing-feature`
3. **Commit changes**: `git commit -m 'Add amazing feature'`
4. **Push to branch**: `git push origin feature/amazing-feature`
5. **Open a Pull Request**

### Development Guidelines
- Follow TypeScript best practices
- Add tests for new audio features
- Update documentation for user-facing changes
- Test on multiple platforms when possible

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- **Silero Team**: For excellent TTS models
- **VS Code Team**: For the extensible editor platform
- **Audio Processing Libraries**: FFmpeg, SoX, pydub
- **Community**: Beta testers and accessibility advocates

## 📞 Support

- **Issues**: Report bugs on [GitHub Issues](https://github.com/gillosae/lipcoder/issues)
- **Discussions**: Join conversations on [GitHub Discussions](https://github.com/gillosae/lipcoder/discussions)
- **Email**: hyway@snu.ac.kr

---

**Made with ❤️ for accessible coding**
