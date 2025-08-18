# Korean Vibe Coding Test File
# This file contains intentional syntax errors for testing Korean vibe coding

def calculate_sum(a, b)
    # Missing colon after function definition
    result = a + b
    return result

def divide_numbers(x, y):
    # Missing error handling for division by zero
    return x / y

class Calculator
    # Missing colon after class definition
    def __init__(self):
        self.history = []
    
    def add(self, a, b):
        result = a + b
        self.history.append(f"{a} + {b} = {result}")
        return result

# Missing main function
if __name__ == "__main__":
    calc = Calculator()
    print(calc.add(5, 3))
    print(divide_numbers(10, 2))
    print(calculate_sum(1, 2))
