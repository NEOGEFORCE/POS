const fs = require('fs');
const path = require('path');

const srcDir = 'C:\\Users\\jaide\\OneDrive\\Desktop\\POS\\FrontPOS-main\\src\\app';

const rules = [
  {
    search: /bg-white dark:bg-\[\#18181b\] dark:bg-\[\#18181b\]\/50 border border-gray-200 dark:border-white\/5/g,
    replace: 'card-base border-none'
  },
  {
    search: /bg-white dark:bg-\[\#18181b\] border border-gray-200 dark:border-white\/5/g,
    replace: 'card-base border-none'
  },
  {
    search: /bg-white dark:bg-\[\#18181b\]/g,
    replace: 'card-base border-none'
  },
  {
    search: /(?<!dark:)bg-zinc-950/g,
    replace: 'bg-white dark:bg-zinc-950'
  },
  {
    search: /(?<!dark:)bg-zinc-900/g,
    replace: 'bg-white dark:bg-zinc-900'
  },
  {
    search: /(?<!dark:)bg-zinc-800/g,
    replace: 'bg-zinc-100 dark:bg-zinc-800'
  },
  {
    search: /(?<!dark:)border-white\/5/g,
    replace: 'border-zinc-200 dark:border-white/5'
  },
  {
    search: /(?<!dark:)border-white\/10/g,
    replace: 'border-zinc-200 dark:border-white/10'
  },
  {
    search: /(?<!dark:)text-zinc-50(?![0-9])/g,
    replace: 'text-zinc-900 dark:text-zinc-50'
  },
  {
    search: /(?<!dark:)text-zinc-100/g,
    replace: 'text-zinc-900 dark:text-zinc-100'
  },
  {
    search: /(?<!dark:)text-zinc-400/g,
    replace: 'text-zinc-500 dark:text-zinc-400'
  },
  {
    search: /text-gray-900 dark:text-white/g,
    replace: 'text-zinc-900 dark:text-zinc-50'
  },
  {
    search: /text-gray-800 dark:text-zinc-200/g,
    replace: 'text-zinc-800 dark:text-zinc-200'
  },
  {
    search: /text-gray-400 dark:text-zinc-500/g,
    replace: 'text-zinc-500 dark:text-zinc-400'
  }
];

let changedFiles = 0;

function walk(dir) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    if (fs.statSync(fullPath).isDirectory()) {
      walk(fullPath);
    } else if (fullPath.endsWith('.tsx') || fullPath.endsWith('.ts')) {
      let content = fs.readFileSync(fullPath, 'utf8');
      let modified = false;

      // Ensure no doubled replacements by first removing existing dual classes if they match our target partially
      
      for (const rule of rules) {
        if (rule.search.test(content)) {
          content = content.replace(rule.search, rule.replace);
          modified = true;
        }
      }

      if (modified) {
        // Cleanups for edge cases where lookbehinds might have failed or double injected
        content = content.replace(/bg-white dark:bg-white dark:/g, 'bg-white dark:');
        content = content.replace(/bg-zinc-100 dark:bg-zinc-100 dark:/g, 'bg-zinc-100 dark:');
        content = content.replace(/border-zinc-200 dark:border-zinc-200 dark:/g, 'border-zinc-200 dark:');
        content = content.replace(/text-zinc-900 dark:text-zinc-900 dark:/g, 'text-zinc-900 dark:');
        content = content.replace(/text-zinc-500 dark:text-zinc-500 dark:/g, 'text-zinc-500 dark:');
        content = content.replace(/bg-white dark:bg-zinc-100 dark:bg-zinc-800/g, 'bg-white dark:bg-zinc-800'); // Clean up nested
        
        fs.writeFileSync(fullPath, content, 'utf8');
        changedFiles++;
      }
    }
  }
}

walk(srcDir);
console.log(`Global refactor applied. Changed ${changedFiles} files.`);
