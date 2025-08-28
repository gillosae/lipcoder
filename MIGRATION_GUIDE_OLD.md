# LipCoder 맥 간 이전 가이드 (Mac-to-Mac Migration Guide)

이 가이드는 LipCoder 프로젝트를 다른 맥으로 이전할 때 필요한 모든 단계를 설명합니다.

## 📋 이전 전 체크리스트

### 1. 현재 시스템 정보 확인
```bash
# 현재 Python 경로 확인
which python3
which python3.11

# Node.js 버전 확인
node --version
npm --version

# Homebrew 설치 확인
brew --version

# Git 설정 확인
git config --list
```

### 2. 중요한 설정 파일들 백업
- `.npmrc` - Python 경로 설정
- `client/src/python/pyvenv.cfg` - Python 가상환경 설정
- VS Code 설정 (API 키들)
- Git 설정

## 🚀 새로운 맥에서의 설치 과정

### 1. 자동 설치 기능 사용 (권장) ⭐

LipCoder v2024에서는 **자동 의존성 설치 기능**이 추가되었습니다!

```bash
# 1. 프로젝트 클론
git clone <repository-url>
cd lipcoder

# 2. VS Code에서 프로젝트 열기
code .

# 3. LipCoder 확장 활성화
# → 자동으로 의존성 체크 및 설치 UI가 나타납니다!
```

**자동 설치 기능:**
- ✅ Node.js & npm 자동 설치
- ✅ Python 3 & pip 자동 설치  
- ✅ Homebrew 자동 설치
- ✅ Python 패키지 (Flask, uvicorn, ASGI, PyTorch 등) 자동 설치
- ✅ 오디오 도구 (FFmpeg, SoX) 자동 설치
- ✅ **네이티브 모듈 (node-pty, speaker) 자동 재빌드**
- ✅ 사용자 친화적인 설치 가이드 제공

### 2. 수동 설치 (고급 사용자용)

자동 설치를 원하지 않는 경우:

```bash
# Homebrew 설치 (없는 경우)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# 필수 도구들 설치
brew install python@3.10 python@3.11 node npm git ffmpeg sox

# Python 경로 확인
which python3.11
# 결과 예: /opt/homebrew/bin/python3.11
```

### 3. 프로젝트 클론 및 기본 설정

```bash
# 프로젝트 클론
git clone <repository-url>
cd lipcoder

# .npmrc 파일 생성/수정 (Python 경로를 새 시스템에 맞게 수정)
echo "python=/opt/homebrew/bin/python3.11" > .npmrc
echo "python=/opt/homebrew/bin/python3.11" > client/.npmrc
```

### 3. Python 가상환경 재설정

```bash
# 기존 가상환경 삭제 (경로가 다르므로)
rm -rf client/src/python

# 새로운 가상환경 생성
cd client/src
python3.11 -m venv python

# 가상환경 활성화
source python/bin/activate

# 필요한 패키지 설치
pip install torch torchaudio silero-tts pydub flask

# 가상환경 비활성화
deactivate
cd ../..
```

### 4. Node.js 의존성 설치

```bash
# 루트 디렉토리에서
npm install

# 클라이언트 의존성
cd client && npm install && cd ..

# 서버 의존성
cd server && npm install && cd ..
```

### 5. macOS 특화 오디오 파일 생성

```bash
# 오디오 생성 스크립트 실행 권한 부여
cd client/audio
chmod +x generate_all_macos.sh
chmod +x *_gen_macos.sh

# macOS TTS 오디오 파일 생성 (시간이 오래 걸림)
./generate_all_macos.sh
```

### 6. 빌드 및 테스트

```bash
# 프로젝트 빌드
npm run build

# 타입 체크
npm run check-types

# 린트 검사
npm run lint
```

## ⚙️ 설정 파일 업데이트

### 1. `.npmrc` 파일 수정
```bash
# 새 시스템의 Python 경로로 업데이트
echo "python=$(which python3.11)" > .npmrc
echo "python=$(which python3.11)" > client/.npmrc
```

### 2. `client/src/python/pyvenv.cfg` 확인
```ini
home = /opt/homebrew/opt/python@3.11/bin
include-system-site-packages = false
version = 3.11.x
```

### 3. VS Code 설정 복원
VS Code에서 다음 설정들을 복원하세요:
- `lipcoder.openaiApiKey` - OpenAI API 키
- `lipcoder.claudeApiKey` - Claude API 키
- `lipcoder.ttsBackend` - TTS 백엔드 설정 (기본: 'macos')
- `lipcoder.asrBackend` - ASR 백엔드 설정
- `lipcoder.macosVoice` - macOS 음성 설정 (기본: 'Yuna')

## 🔧 macOS 특화 기능 확인

### 1. macOS TTS 서버 테스트
```bash
# macOS TTS 서버 시작
cd server
python3 macos_tts_server.py

# 다른 터미널에서 테스트
curl -X GET http://localhost:5008/health
curl -X GET http://localhost:5008/voices
```

### 2. 음성 명령어 테스트
```bash
# 사용 가능한 macOS 음성 확인
say -v ?

# Yuna 음성 테스트 (한국어 지원)
say -v Yuna "안녕하세요"
say -v Yuna "Hello, this is a test"
```

### 3. 오디오 파일 확인
```bash
# 생성된 오디오 파일 확인
ls -la client/audio/alphabet_macos/
ls -la client/audio/number_macos/
ls -la client/audio/python_macos/
ls -la client/audio/typescript_macos/
ls -la client/audio/special_macos/
```

## 🐛 일반적인 문제 해결

### 1. Python 경로 문제
```bash
# 에러: "Can't find Node.js binary" 또는 "path does not exist" (VS Code F5 실행 시)
# 해결 1: 자동 Node.js 경로 설정 (권장)
npm run setup-node

# 해결 2: 수동으로 Node.js 경로 확인
which node
# 결과를 .vscode/launch.json의 runtimeExecutable에 설정

# 해결 3: Python 경로 문제
# 에러: Python을 찾을 수 없음
# 해결: .npmrc 파일의 Python 경로 확인 및 수정
which python3.11
echo "python=$(which python3.11)" > .npmrc
```

### 2. 가상환경 문제
```bash
# 에러: 가상환경 활성화 실패
# 해결: 가상환경 재생성
rm -rf client/src/python
cd client/src
python3.11 -m venv python
```

### 3. 오디오 파일 생성 실패
```bash
# 에러: macOS TTS 파일 생성 실패
# 해결: 권한 확인 및 스크립트 재실행
cd client/audio
chmod +x *.sh
./generate_all_macos.sh
```

### 4. FFmpeg 관련 문제
```bash
# 에러: FFmpeg를 찾을 수 없음
# 해결: Homebrew로 FFmpeg 설치
brew install ffmpeg sox
```

### 5. Node.js 네이티브 모듈 문제
```bash
# 에러: node-pty 또는 speaker 모듈 로드 실패
# 해결 1: 개별 모듈 재빌드
npm rebuild node-pty
npm rebuild speaker

# 해결 2: 전체 네이티브 모듈 재빌드
npm rebuild

# 해결 3: 완전 재설치
npm install --build-from-source

# 참고: 네이티브 모듈이 없어도 LipCoder는 fallback으로 동작합니다
# - node-pty 없으면 → VS Code 기본 터미널 사용
# - speaker 없으면 → 시스템 오디오 API 사용
```

## 📝 이전 후 확인사항

### 1. 기능 테스트
- [ ] VS Code 확장 로드 확인
- [ ] TTS 음성 출력 테스트
- [ ] ASR 음성 인식 테스트
- [ ] 오디오 파일 재생 테스트
- [ ] macOS 네이티브 음성 테스트

### 2. 설정 확인
- [ ] API 키 설정 완료
- [ ] 음성 백엔드 설정 확인
- [ ] 오디오 파일 경로 확인
- [ ] Python 가상환경 정상 작동

### 3. 성능 확인
- [ ] 빌드 시간 정상
- [ ] 오디오 지연시간 확인
- [ ] 메모리 사용량 확인

## 🔧 새로운 의존성 관리 명령어

LipCoder v2024에서 추가된 편리한 명령어들:

### VS Code 명령 팔레트에서 사용 (Cmd+Shift+P)

- **`LipCoder: Check Dependencies`** - 모든 의존성 체크 및 자동 설치
- **`LipCoder: Show Dependency Status`** - 현재 의존성 상태 확인  
- **`LipCoder: Check Node.js Installation`** - Node.js 전용 체크
- **`LipCoder: Check Native Modules`** - node-pty, speaker 등 네이티브 모듈 체크

### 터미널에서 사용 가능한 스크립트

- **`npm run setup`** - 전체 프로젝트 설정 (Node.js 경로 + 빌드)
- **`npm run setup-node`** - Node.js 경로 자동 감지 및 launch.json 업데이트
- **`npm run build`** - TypeScript 컴파일
- **`npm run package`** - 프로덕션 빌드 (esbuild 번들링 포함)

### 터미널에서 수동 체크

```bash
# Node.js 확인
node --version
npm --version

# Python 패키지 확인
python3 -c "import flask; print('Flask:', flask.__version__)"
python3 -c "import uvicorn; print('Uvicorn:', uvicorn.__version__)"
python3 -c "import torch; print('PyTorch:', torch.__version__)"

# 시스템 도구 확인
brew --version
ffmpeg -version

# 네이티브 모듈 확인
node -e "require('node-pty'); console.log('node-pty: OK')"
node -e "require('speaker'); console.log('speaker: OK')"
```

## 💡 최적화 팁

### 1. 빌드 성능 향상
```bash
# 병렬 빌드 사용
npm run build -- --parallel

# 캐시 활용
npm ci --cache .npm
```

### 2. 오디오 성능 최적화
- macOS 네이티브 TTS 사용 (가장 빠름)
- 오디오 캐시 활용
- 불필요한 오디오 파일 정리

### 3. 개발 환경 최적화
```bash
# 개발 모드에서 빠른 빌드
npm run watch

# 타입 체크만 실행
npm run check-types
```

## 🔗 추가 리소스

- [LipCoder README](./README.md)
- [VIBE_CODING.md](./VIBE_CODING.md)
- [VOICE_COMMANDS.md](./VOICE_COMMANDS.md)
- [macOS TTS 설정 가이드](./XTTS_VOICE_OPTIMIZATION.md)

## 📞 지원

문제가 발생하면:
1. 이 가이드의 문제 해결 섹션 확인
2. GitHub Issues에서 유사한 문제 검색
3. 새로운 이슈 생성 (시스템 정보 포함)

---

**🎉 이전 완료 후 LipCoder의 모든 기능을 새로운 맥에서 즐기세요!**
