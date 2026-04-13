const fs = require('fs');
const content = fs.readFileSync('src/app/(app)/sales/returns/page.tsx', 'utf8');

function checkDelimiters(content) {
    const stack = [];
    const open = { '{': '}', '(': ')', '[': ']' };
    const close = { '}': '{', ')': '(', ']': '[' };
    
    let lineNum = 1;
    let colNum = 1;
    
    for (let i = 0; i < content.length; i++) {
        const char = content[i];
        if (open[char]) {
            stack.push({ char, lineNum, colNum });
        } else if (close[char]) {
            if (stack.length === 0) {
                console.log(`Extra close ${char} at line ${lineNum}, col ${colNum}`);
                return false;
            }
            const last = stack.pop();
            if (last.char !== close[char]) {
                console.log(`Mismatch: found ${char} at line ${lineNum}, col ${colNum}, but expected matching for ${last.char} from line ${last.lineNum}, col ${last.colNum}`);
                return false;
            }
        }
        
        if (char === '\n') {
            lineNum++;
            colNum = 1;
        } else {
            colNum++;
        }
    }
    
    if (stack.length > 0) {
        const last = stack.pop();
        console.log(`Unclosed ${last.char} from line ${last.lineNum}, col ${last.colNum} at end of file`);
        return false;
    }
    
    console.log("SUCCESS: All delimiters are balanced.");
    return true;
}

checkDelimiters(content);
