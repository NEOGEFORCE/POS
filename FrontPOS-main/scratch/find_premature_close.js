
const fs = require('fs');
const content = fs.readFileSync('src/app/(app)/sales/returns/page.tsx', 'utf8');

function findPrematureClose(content) {
    let braces = 0;
    let lineNum = 1;
    let foundStart = false;
    
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes('export default function ReturnsPage')) {
            foundStart = true;
        }
        
        for (const char of line) {
            if (char === '{') braces++;
            if (char === '}') braces--;
        }
        
        if (foundStart && braces === 0) {
            console.log(`Brace balance reached 0 at line ${i + 1}`);
            console.log(`Content of line ${i + 1}: ${line}`);
            // Don't exit yet, keep going to see if it stays 0
        }
    }
}

findPrematureClose(content);
