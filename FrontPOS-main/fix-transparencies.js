const fs = require('fs');
const path = require('path');

const directory = 'C:\\Users\\jaide\\OneDrive\\Desktop\\POS\\FrontPOS-main\\src';

const exceptions = [
  'ScannerOverlay.tsx',
  'toast.tsx',
  'app-header.tsx',
  'app-sidebar.tsx',
  'globals.css',
  'ConfirmDialog.tsx',
  'SplitBillDialog.tsx',
  'UniversalPaymentModal.tsx',
  'card.tsx',
  'dialog.tsx',
  'dropdown-menu.tsx',
  'popover.tsx',
  'select.tsx'
];

function processFile(filePath) {
  const fileName = path.basename(filePath);
  if (exceptions.includes(fileName)) return;

  let content = fs.readFileSync(filePath, 'utf8');
  let originalContent = content;

  // Replace backdrop-blur variations
  content = content.replace(/\bbackdrop-blur-(sm|md|lg|xl|2xl|3xl)\b/g, '');
  content = content.replace(/\bbackdrop-blur\b/g, '');

  // Replace background variations
  content = content.replace(/\bbg-black\/[2-7][0-9]\b/g, 'bg-zinc-900');
  content = content.replace(/\bbg-black\/80\b/g, 'bg-zinc-950');
  content = content.replace(/\bbg-white\/[89]0\b/g, 'bg-white dark:bg-zinc-900');
  content = content.replace(/\bbg-white\/10\b/g, 'bg-zinc-800');
  content = content.replace(/\bbg-white\/5\b/g, 'bg-zinc-900');

  if (content !== originalContent) {
    // Clean up multiple spaces within the lines (naive, but avoids touching start-of-line indentation)
    // Actually, just leaving double spaces is safer for JSX indentation
    fs.writeFileSync(filePath, content, 'utf8');
    console.log('Updated:', filePath);
  }
}

function walkDir(dir) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    if (fs.statSync(fullPath).isDirectory()) {
      walkDir(fullPath);
    } else if (fullPath.endsWith('.tsx') || fullPath.endsWith('.ts')) {
      processFile(fullPath);
    }
  }
}

walkDir(directory);
