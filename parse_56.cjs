const fs = require('fs');
const lines = fs.readFileSync('test_batchdata/56_properties_raw.txt', 'utf8')
  .split('\n')
  .map(l => l.trim())
  .filter(Boolean);

let addrs = [];
let st = '';

for(let l of lines) {
  if(/^[0-9]+$/.test(l)) continue;
  if(/^[0-9]+[mdh]$/.test(l)) continue;
  if(['START','All','Todo 56', 'Todo', 'Done 0', 'Done'].includes(l) || l.startsWith('0/56')) continue;
  if(l.includes('Can you run this like through batch data')) continue;
  
  if(!st) {
    st = l;
  } else {
    addrs.push(`${st}, ${l}`);
    st = '';
  }
}

fs.writeFileSync('test_batchdata/56_properties.txt', addrs.join('\n'));
console.log(`Parsed ${addrs.length} addresses`);
