const { Client } = require('ssh2');

const WAYSTAR_HOST = process.env.WAYSTAR_HOST;
const WAYSTAR_USER = process.env.WAYSTAR_USER;
const WAYSTAR_PASS = process.env.WAYSTAR_PASS;

function connectSftp() {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn.on('ready', () => conn.sftp((err, sftp) => err ? (conn.end(), reject(err)) : resolve({ conn, sftp })));
    conn.on('error', err => reject(new Error(`SSH failed: ${err.message}`)));
    conn.connect({ host: WAYSTAR_HOST, port: 22, username: WAYSTAR_USER, password: WAYSTAR_PASS, readyTimeout: 30000 });
  });
}
function readdir(sftp, dir) {
  return new Promise((resolve, reject) => sftp.readdir(dir, (err, list) => err ? reject(new Error(`readdir failed: ${err.message}`)) : resolve(list)));
}
function readFile(sftp, p) {
  return new Promise((resolve, reject) => {
    let buf = ''; const s = sftp.createReadStream(p, { encoding: 'utf8' });
    s.on('data', c => buf += c); s.on('end', () => resolve(buf)); s.on('error', reject);
  });
}

async function main() {
  console.log('=== 277 CLAIM STATUS RECON (read-only) ===');
  const { conn, sftp } = await connectSftp();
  console.log('Connected.\n');

  const list = await readdir(sftp, '/Download');
  const names = list.map(f => f.filename);

  // count file types present
  const types = {};
  names.forEach(n => {
    const m = n.match(/\.(\d{3})\.edi/i) || n.match(/\.(ERA|ELG|CLP)\.(\d{3})/i);
    const key = n.replace(/^[0-9.]+/, '').replace(/\d{14,}/,'') || 'other';
    types[key] = (types[key] || 0) + 1;
  });
  console.log('--- FILE TYPE TALLY (by suffix pattern) ---');
  Object.entries(types).sort((a,b)=>b[1]-a[1]).forEach(([k,v]) => console.log(`  ${v}\t${k}`));
  console.log('');

  // find the 277 files
  const f277 = names.filter(n => /\.277\.edi$/i.test(n) || /\.CLP\.277/i.test(n)).sort();
  console.log(`Found ${f277.length} 277-type files. Samples:`);
  f277.slice(0, 8).forEach(n => console.log('  ' + n));
  console.log('');

  if (!f277.length) {
    console.log('No 277 files found. All filenames containing "277":');
    names.filter(n => n.includes('277')).slice(0,20).forEach(n => console.log('  ' + n));
    conn.end(); return;
  }

  // dump the largest 277 (most claims) so we see real STC status segments
  let target = f277[0], maxSize = 0;
  for (const f of list) {
    if (/\.277\.edi$/i.test(f.filename) || /\.CLP\.277/i.test(f.filename)) {
      const sz = f.attrs && f.attrs.size ? f.attrs.size : 0;
      if (sz > maxSize) { maxSize = sz; target = f.filename; }
    }
  }
  console.log(`=== DUMPING: ${target} (${maxSize} bytes) ===`);
  const content = await readFile(sftp, `/Download/${target}`);
  const elemSep = content[3] || '*';
  const segTerm = content[105] || '~';
  console.log(`elemSep="${elemSep}"  segTerm="${segTerm}"  length=${content.length}\n`);

  const segs = content.split(segTerm).map(s => s.trim()).filter(Boolean);
  console.log('--- FIRST 60 SEGMENTS ---');
  segs.slice(0, 60).forEach(s => console.log(s));

  console.log('\n--- ALL UNIQUE SEGMENT IDS ---');
  console.log([...new Set(segs.map(s => s.split(elemSep)[0]))].join(', '));

  conn.end();
  console.log('\n=== DONE ===');
}
main().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
