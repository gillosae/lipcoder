#!/usr/bin/env python3
"""
Simple test script to verify the Python execution voice command works.
"""

import sys
import time

def main():
    print("🐍 Python execution test started!")
    print(f"Python version: {sys.version}")
    print("This script was executed via lipcoder voice command: 'run test_python_execution.py'")
    
    # Simple countdown
    for i in range(3, 0, -1):
        print(f"Countdown: {i}")
        time.sleep(1)
    
    print("✅ Test completed successfully!")
    print("Voice command execution working correctly!")

if __name__ == "__main__":
    main()
