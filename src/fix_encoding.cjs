const fs=require('fs');
let c=fs.readFileSync('main.ts','utf8');
c=c.replace(/'\?\?: 0x21/g, "'⇞': 0x21");
c=c.replace(/'\?\?: 0x22/g, "'⇟': 0x22");
c=c.replace(/'\?\?: 0x24/g, "'↖': 0x24");
c=c.replace(/'\?\?: 0x23/g, "'↘': 0x23");
c=c.replace(/'\?\?: 0x1B/g, "'⎋': 0x1B");
c=c.replace(/'\?\?: 0x2E/g, "'⌦': 0x2E");
c=c.replace(/confirm\(`\?\?\?\?\?\?\?\? \(\$\{color\}\) \?\?\?\?\?\?\? \$\{names\[prop as string\]\} \?\?`\)/g, "confirm(`確定要將目前的顏色 (${color}) 套用到全部按鈕的 ${names[prop as string]} 嗎？`)");
c=c.replace(/confirm\(`\?\?\?\?\?\?\?\? \(\$\{color\}\) \?\?\?\?\?\?\? \?\?`\)/g, "confirm(`確定要將目前的背景色 (${color}) 套用到全部按鈕嗎？`)");
c=c.replace(/alert\(`\?\?\?\?\?\? \$\{names\[prop as string\]\}\?\?\?\?\?\?\?\?\?\?\?\?\?\?`\)/g, "alert(`已套用至全部 ${names[prop as string]}，包含全域主題與切換預覽`)");
c=c.replace(/alert\("(?:\?\?)+"\)/g, "alert(\"背景已套用到全部\")");
c=c.replace(/alert\(`\?\?\?\?\?\? \$\{names\[prop as string\]\}`\)/g, "alert(`已套用至全部 ${names[prop as string]}`)");

// fix the string literals that got converted to ?? by the Add-Content encoding bug earlier.
// Actually, earlier TS errors were at 886: Unterminated string literal, which is exactly '??: 0x21
fs.writeFileSync('main.ts',c);
console.log("fixed!");
