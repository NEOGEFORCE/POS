const fs = require('fs');
const content = fs.readFileSync('c:/Users/jaide/Desktop/POS/FrontPOS-main/src/app/(app)/inventory/orders/page.tsx', 'utf8');

function checkBalance(str) {
  const stack = [];
  const map = {
    '(': ')',
    '[': ']',
    '{': '}',
    '<': '>'
  };
  const inverseMap = {
    ')': '(',
    ']': '[',
    '}': '{',
    '>': '<'
  };

  let inString = false;
  let quoteType = '';
  let inComment = false;
  let commentType = '';

  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    const nextChar = str[i+1];

    if (inComment) {
      if (commentType === '//' && char === '\n') inComment = false;
      if (commentType === '/*' && char === '*' && nextChar === '/') {
        inComment = false;
        i++;
      }
      continue;
    }

    if (inString) {
      if (char === quoteType && str[i-1] !== '\\') inString = false;
      continue;
    }

    if (char === '/' && nextChar === '/') {
      inComment = true;
      commentType = '//';
      i++;
      continue;
    }
    if (char === '/' && nextChar === '*') {
      inComment = true;
      commentType = '/*';
      i++;
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      inString = true;
      quoteType = char;
      continue;
    }

    if (map[char]) {
      // For JSX, < can be tricky, let's ignore it for now or be careful
      if (char === '<') {
        // Only push if it looks like a tag start: <A or <div or </
        if (/[a-zA-Z/]/.test(nextChar)) {
          stack.push({ char, line: str.substring(0, i).split('\n').length });
        }
      } else {
        stack.push({ char, line: str.substring(0, i).split('\n').length });
      }
    } else if (inverseMap[char]) {
      if (char === '>') {
          // Only pop if it matches a <
          if (stack.length > 0 && stack[stack.length - 1].char === '<') {
              stack.pop();
          }
      } else {
        const last = stack.pop();
        if (!last || last.char !== inverseMap[char]) {
          console.log(`Unbalanced ${char} at line ${str.substring(0, i).split('\n').length}. Expected ${last ? last.char : 'nothing'}`);
          // return false;
        }
      }
    }
  }

  if (stack.length > 0) {
    console.log("Still open:");
    stack.forEach(s => console.log(`${s.char} at line ${s.line}`));
    return false;
  }

  console.log("All balanced!");
  return true;
}

checkBalance(content);
