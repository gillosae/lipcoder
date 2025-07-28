#!/bin/bash
cd "$(dirname "$0")"
exec /opt/homebrew/opt/python@3.10/Frameworks/Python.framework/Versions/3.10/bin/python3.10 -m gunicorn --workers 2 --bind 0.0.0.0:$1 silero_tts_server:app 