#!/bin/bash
cd "$(dirname "$0")"

# Use the system python3 that has Flask installed
export PORT=${1:-5005}
exec /opt/homebrew/opt/python@3.10/bin/python3.10 espeak_tts_server.py 