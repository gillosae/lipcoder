// Demonstration of File Exploration Features in Lipcoder
// This shows how to examine, find, and modify files while having another file open

import { processSampleData, getEmployeesByDepartment, getAverageSalaryByDepartment } from './sample_data_processor';

/**
 * Demo: How to use the new file exploration features
 * 
 * Voice Commands Available:
 * 1. "find files" - Search for files by pattern
 * 2. "find csv" - Find CSV files specifically  
 * 3. "examine file" - Examine content of a specific file
 * 4. "file browser" - Interactive file browser
 * 5. "create csv function" - Generate TypeScript functions from CSV structure
 */

async function demonstrateFileExploration() {
    console.log('🔍 File Exploration Demo');
    console.log('========================');
    
    // Example 1: Process the sample CSV data
    try {
        const csvPath = './sample_data.csv';
        const employees = await processSampleData(csvPath);
        
        console.log(`\n📊 Loaded ${employees.length} employee records:`);
        employees.forEach((emp, i) => {
            console.log(`${i + 1}. ${emp.name} - ${emp.role} (${emp.department})`);
        });
        
        // Example 2: Find employees by department
        const engineeringTeam = await getEmployeesByDepartment(employees, 'Engineering');
        console.log(`\n👨‍💻 Engineering Team (${engineeringTeam.length} members):`);
        engineeringTeam.forEach(emp => {
            console.log(`  - ${emp.name}: ${emp.role} ($${emp.salary})`);
        });
        
        // Example 3: Calculate average salaries by department
        const avgSalaries = await getAverageSalaryByDepartment(employees);
        console.log('\n💰 Average Salaries by Department:');
        Object.entries(avgSalaries).forEach(([dept, avg]) => {
            console.log(`  - ${dept}: $${avg.toLocaleString()}`);
        });
        
    } catch (error) {
        console.error('Error processing CSV:', error);
    }
}

/**
 * Example workflow for file exploration while coding:
 * 
 * 1. You're editing conversational_popup.ts (current file open)
 * 2. Say "find csv" to discover CSV files in the project
 * 3. Say "examine file" and enter "sample_data.csv" to see its structure
 * 4. Say "create csv function" to generate TypeScript processor
 * 5. The generated function opens in a new editor tab
 * 6. You can now use the CSV data in your original file
 */

// Example integration with existing lipcoder functionality
class FileExplorationHelper {
    /**
     * Search for configuration files
     */
    static async findConfigFiles(): Promise<string[]> {
        // This would use the new file search functionality
        // Voice command: "find files" then enter "*.json"
        return ['package.json', 'tsconfig.json', 'eslint.config.mjs'];
    }
    
    /**
     * Examine project structure
     */
    static async examineProjectStructure(): Promise<void> {
        // Voice command: "file browser" 
        // Then navigate through directories interactively
        console.log('Use "file browser" voice command to explore project structure');
    }
    
    /**
     * Quick access to data files
     */
    static async findDataFiles(): Promise<void> {
        // Voice command: "find files" then enter "*.csv,*.json,*.txt"
        console.log('Use "find files" to locate data files by extension');
    }
}

// Export for use in other files
export { demonstrateFileExploration, FileExplorationHelper };

// Run demo if this file is executed directly
if (require.main === module) {
    demonstrateFileExploration().catch(console.error);
}
