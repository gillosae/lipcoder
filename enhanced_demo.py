#!/usr/bin/env python3
"""
Another enhanced test script to verify disambiguation when multiple files match.
"""

import sys
import time

def main():
    print("🎭 Enhanced Demo Script (Root Directory)")
    print(f"Python version: {sys.version}")
    print("This is the ROOT directory version of the enhanced test.")
    print()
    
    print("🤔 If you said 'run enhanced', you should see a disambiguation dialog")
    print("   because there are multiple files matching 'enhanced':")
    print("   - enhanced_demo.py (this file, in root)")
    print("   - test_scripts/enhanced_test.py (in subdirectory)")
    print()
    
    for i in range(3, 0, -1):
        print(f"Demo countdown: {i}")
        time.sleep(1)
    
    print("✅ Root enhanced demo completed!")

if __name__ == "__main__":
    main()
