const fs = require('fs');

const content = fs.readFileSync('c:\\Users\\jaide\\Desktop\\POS\\FrontPOS-main\\src\\app\\(app)\\customers\\page.tsx', 'utf8');
let braceBalance = 0;
let parenBalance = 0;
let inString = false;
let stringChar = '';

for (let i = 0; i < content.length; i++) {
    const char = content[i];
    if (inString) {
        if (char === stringChar && content[i-1] !== '\\') inString = false;
        continue;
    }
    if (char === '"' || char === "'" || char === '`') {
        inString = true;
        stringChar = char;
        continue;
    }

    if (char === '{') braceBalance++;
    if (char === '}') braceBalance--;
    if (char === '(') parenBalance++;
    if (char === ')') parenBalance--;
}

console.log('Brace Balance:', braceBalance);
console.log('Paren Balance:', parenBalance);
