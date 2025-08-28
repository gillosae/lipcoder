#!/usr/bin/env python3
"""
University Management System
A simple example for testing file opening functionality in lipcoder
"""

import matplotlib.pyplot as plt
import numpy as np

class University:
    def __init__(self, name: str, location: str):
        self.name = name
        self.location = location
        self.students = []
        self.faculty = []
        self.departments = []

    def add_student(self, student_name: str, student_id: str, major: str):
        """Add a new student to the university"""
        student = {
            'name': student_name,
            'id': student_id,
            'major': major,
            'enrolled_courses': []
        }
        self.students.append(student)
        return student

    def add_faculty(self, faculty_name: str, faculty_id: str, department: str):
        """Add a new faculty member"""
        faculty = {
            'name': faculty_name,
            'id': faculty_id,
            'department': department,
            'courses_taught': []
        }
        self.faculty.append(faculty)
        return faculty

    def create_department(self, dept_name: str, dept_head: str):
        """Create a new department"""
        department = {
            'name': dept_name,
            'head': dept_head,
            'courses': [],
            'faculty_count': 0,
            'student_count': 0
        }
        self.departments.append(department)
        return department

    def get_student_count(self) -> int:
        """Get total number of students"""
        return len(self.students)

    def get_faculty_count(self) -> int:
        """Get total number of faculty"""
        return len(self.faculty)

    def get_department_count(self) -> int:
        """Get total number of departments"""
        return len(self.departments)

    def __str__(self) -> str:
        return f"University: {self.name} ({self.location})"

    def __repr__(self) -> str:
        return f"University(name='{self.name}', location='{self.location}')"
    
    def plot_statistics(self, use_different_colors: bool = False) -> None:
        """Plot university statistics with optional different colors for each bar"""
        categories = ['Students', 'Faculty', 'Departments']
        counts = [self.get_student_count(), self.get_faculty_count(), self.get_department_count()]
        
        plt.figure(figsize=(10, 6))
        
        if use_different_colors:
            # Use different colors for each bar
            colors = ['#FF6B6B', '#4ECDC4', '#45B7D1']  # Red, Teal, Blue
            bars = plt.bar(categories, counts, color=colors)
        else:
            # Use default single color
            bars = plt.bar(categories, counts)
        
        plt.title(f'{self.name} Statistics', fontsize=16, fontweight='bold')
        plt.xlabel('Category', fontsize=12)
        plt.ylabel('Count', fontsize=12)
        
        # Add value labels on top of bars
        for bar, count in zip(bars, counts):
            plt.text(bar.get_x() + bar.get_width()/2, bar.get_height() + 0.1, 
                    str(count), ha='center', va='bottom', fontweight='bold')
        
        plt.grid(axis='y', alpha=0.3)
        plt.tight_layout()
        plt.show()
    
    def plot_department_comparison(self) -> None:
        """Plot comparison of students and faculty by department with different colors"""
        if not self.departments:
            print("No departments to plot")
            return
        
        dept_names = [dept['name'] for dept in self.departments]
        
        # Count students and faculty by department
        student_counts = []
        faculty_counts = []
        
        for dept in self.departments:
            dept_name = dept['name']
            student_count = sum(1 for student in self.students if student['major'] == dept_name)
            faculty_count = sum(1 for faculty in self.faculty if faculty['department'] == dept_name)
            student_counts.append(student_count)
            faculty_counts.append(faculty_count)
        
        x = np.arange(len(dept_names))
        width = 0.35
        
        plt.figure(figsize=(12, 6))
        
        # Use different colors for students and faculty bars
        bars1 = plt.bar(x - width/2, student_counts, width, label='Students', color='#FF9999')
        bars2 = plt.bar(x + width/2, faculty_counts, width, label='Faculty', color='#66B2FF')
        
        plt.title(f'{self.name} - Department Comparison', fontsize=16, fontweight='bold')
        plt.xlabel('Department', fontsize=12)
        plt.ylabel('Count', fontsize=12)
        plt.xticks(x, dept_names)
        plt.legend()
        
        # Add value labels on bars
        for bars in [bars1, bars2]:
            for bar in bars:
                height = bar.get_height()
                plt.text(bar.get_x() + bar.get_width()/2, height + 0.05,
                        str(int(height)), ha='center', va='bottom', fontweight='bold')
        
        plt.grid(axis='y', alpha=0.3)
        plt.tight_layout()
        plt.show()


def main():
    """Example usage of the University class"""
    # Create a university
    university = University("Tech University", "Silicon Valley")
    
    # Add some departments
    cs_dept = university.create_department("Computer Science", "Dr. Smith")
    math_dept = university.create_department("Mathematics", "Dr. Johnson")
    
    # Add faculty
    university.add_faculty("Dr. Alice Brown", "F001", "Computer Science")
    university.add_faculty("Dr. Bob Wilson", "F002", "Mathematics")
    
    # Add students
    university.add_student("John Doe", "S001", "Computer Science")
    university.add_student("Jane Smith", "S002", "Mathematics")
    university.add_student("Mike Johnson", "S003", "Computer Science")
    
    # Print university info
    print(university)
    print(f"Students: {university.get_student_count()}")
    print(f"Faculty: {university.get_faculty_count()}")
    print(f"Departments: {university.get_department_count()}")
    
    # List all students
    print("\nStudents:")
    for student in university.students:
        print(f"  - {student['name']} ({student['id']}) - {student['major']}")
    
    # List all faculty
    print("\nFaculty:")
    for faculty in university.faculty:
        print(f"  - {faculty['name']} ({faculty['id']}) - {faculty['department']}")
    
    # Plot statistics with different colors
    print("\nGenerating plots...")
    university.plot_statistics(use_different_colors=True)
    university.plot_department_comparison()


if __name__ == "__main__":
    main()
