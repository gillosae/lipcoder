#!/usr/bin/env python3
"""
Test file for indentation earcon functionality
Type in this file to test the indentation earcon system:
- indent_0 to indent_4: for indenting (들여쓰기)
- indent_5 to indent_9: for outdenting (내어쓰기)
"""

def test_function():
    print("Level 1 indentation")
    if True:
        print("Level 2 indentation")
        for i in range(3):
            print("Level 3 indentation")
            if i > 0:
                print("Level 4 indentation")
                while i < 2:
                    print("Level 5 indentation")
                    break
            print("Back to level 3")
        print("Back to level 2")
    print("Back to level 1")

# Test by typing new indented lines here:
# Try adding spaces or tabs to create different indentation levels
# The earcon system should play different sounds based on indentation changes

if __name__ == "__main__":
    test_function()
