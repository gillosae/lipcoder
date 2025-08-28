# LipCoder 시스템 요구사항 (System Requirements)

이 문서는 LipCoder가 정상적으로 작동하는 데 필요한 모든 도구들의 정확한 버전을 명시합니다.

## 🎯 테스트된 환경

**운영체제**: macOS (Apple Silicon/Intel 모두 지원)  
**테스트 시스템**: macOS 14+ (Sonoma)

## 📋 필수 도구 및 정확한 버전

### 1. Node.js 환경
```bash
Node.js: v23.11.0
npm: 10.9.2
```

**설치 방법**:
```bash
# Homebrew를 통한 설치 (권장)
brew install node@23

# 또는 공식 사이트에서 다운로드
# https://nodejs.org/download/release/v23.11.0/
```

### 2. Python 환경
```bash
Python: 3.10.17
```

**설치 방법**:
```bash
# Homebrew를 통한 설치 (권장)
brew install python@3.10

# 버전 확인
python3 --version  # Python 3.10.17
```

### 3. 패키지 관리자
```bash
Homebrew: 4.6.7
```

**설치 방법**:
```bash
# Homebrew 설치
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# 버전 확인
brew --version  # Homebrew 4.6.7
```

### 4. 오디오 처리 도구
```bash
FFmpeg: 7.1.1_2
SoX: 14.4.2_6
```

**설치 방법**:
```bash
# Homebrew를 통한 설치
brew install ffmpeg sox

# 버전 확인
ffmpeg -version | head -1  # ffmpeg version 7.1.1
brew list sox --versions   # sox 14.4.2_6
```

### 5. Node.js 네이티브 모듈
```bash
node-pty: 1.0.0
speaker: 0.5.5
```

**자동 설치**: `npm install` 시 자동으로 설치됩니다.

### 6. Python 패키지 (가상환경)
```bash
Flask==2.3.3
flask-cors==6.0.1
uvicorn==0.35.0
asgiref==3.9.1
torch==2.8.0
torchaudio==2.8.0
torchvision==0.23.0
TTS==0.22.0
soundfile==0.12.1
numpy==1.22.0
pytorch-lightning==2.4.0
torchmetrics==1.6.0
torchsde==0.2.6
torchdiffeq==0.2.5
clip-anytorch==2.6.0
```

**자동 설치**: LipCoder 가상환경 설정 시 자동으로 설치됩니다.

## 🚀 한 번에 설치하기

### 모든 시스템 도구 설치
```bash
# Homebrew 설치 (아직 없다면)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# 모든 필수 도구 설치
brew install node@23 python@3.10 ffmpeg sox git

# 버전 확인
node --version    # v23.11.0
npm --version     # 10.9.2
python3 --version # Python 3.10.17
ffmpeg -version | head -1
brew list sox --versions
```

### LipCoder 프로젝트 설정
```bash
# 프로젝트 클론
git clone <your-repo-url>
cd lipcoder

# Node.js 의존성 설치
npm install

# 프로젝트 빌드
npm run build

# VS Code에서 실행
code .
# F5 키를 눌러 LipCoder 실행
# 가상환경 설정 안내가 나타나면 "🚀 지금 설정하기" 클릭
```

## 🔍 버전 확인 스크립트

모든 도구가 올바른 버전으로 설치되었는지 확인하는 스크립트:

```bash
#!/bin/bash
echo "=== LipCoder 시스템 요구사항 체크 ==="
echo

echo "📦 패키지 관리자:"
brew --version 2>/dev/null || echo "❌ Homebrew 미설치"
echo

echo "🟢 Node.js 환경:"
node --version 2>/dev/null || echo "❌ Node.js 미설치"
npm --version 2>/dev/null || echo "❌ npm 미설치"
echo

echo "🐍 Python 환경:"
python3 --version 2>/dev/null || echo "❌ Python3 미설치"
echo

echo "🎵 오디오 도구:"
ffmpeg -version 2>/dev/null | head -1 || echo "❌ FFmpeg 미설치"
sox --version 2>/dev/null | head -1 || echo "❌ SoX 미설치"
echo

echo "🔧 Node.js 네이티브 모듈:"
node -e "try { require('node-pty'); console.log('✅ node-pty: OK'); } catch(e) { console.log('❌ node-pty:', e.message); }" 2>/dev/null
node -e "try { require('speaker'); console.log('✅ speaker: OK'); } catch(e) { console.log('❌ speaker:', e.message); }" 2>/dev/null
echo

echo "🐍 Python 가상환경:"
if [ -f "server/lipcoder_venv/bin/python" ]; then
    echo "✅ 가상환경 존재: $(server/lipcoder_venv/bin/python --version)"
    server/lipcoder_venv/bin/python -c "import torch, TTS, flask; print('✅ 핵심 패키지 OK')" 2>/dev/null || echo "⚠️ 일부 패키지 누락"
else
    echo "❌ 가상환경 미설정 - VS Code에서 F5 실행 후 설정하세요"
fi
```

## 💡 호환성 정보

### macOS 버전
- **최소 요구사항**: macOS 12.0 (Monterey)
- **권장**: macOS 14.0+ (Sonoma)
- **테스트됨**: macOS 14.x (Sonoma)

### 아키텍처
- ✅ **Apple Silicon (M1/M2/M3)**: 완전 지원
- ✅ **Intel x86_64**: 완전 지원

### VS Code
- **최소 요구사항**: VS Code 1.74.0+
- **권장**: 최신 버전

## ⚠️ 주의사항

1. **정확한 버전 사용**: 다른 버전을 사용하면 호환성 문제가 발생할 수 있습니다.

2. **가상환경 사용**: Python 패키지는 반드시 LipCoder 전용 가상환경에 설치하세요.

3. **네이티브 모듈**: Node.js 버전이 바뀌면 네이티브 모듈을 재빌드해야 합니다.

4. **Homebrew 권장**: 모든 도구를 Homebrew로 설치하는 것을 강력히 권장합니다.

## 🆘 문제 해결

버전 관련 문제가 발생하면:

1. **전체 재설치**:
   ```bash
   # 기존 도구 제거
   brew uninstall node python@3.10 ffmpeg sox
   
   # 정확한 버전 재설치
   brew install node@23 python@3.10 ffmpeg sox
   ```

2. **가상환경 재설정**:
   ```bash
   # 가상환경 삭제
   rm -rf server/lipcoder_venv
   
   # VS Code에서 F5 실행하여 재설정
   ```

3. **네이티브 모듈 재빌드**:
   ```bash
   npm rebuild
   ```

이 문서의 모든 버전은 실제 작동하는 시스템에서 테스트되었습니다. 정확히 이 버전들을 사용하면 LipCoder가 완벽하게 작동할 것입니다! 🚀
