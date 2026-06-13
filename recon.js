const { Client } = require('ssh2');

const WAYSTAR_HOST = process.env.WAYSTAR_HOST;
const WAYSTAR_USER = process.env.WAYSTAR_USER;
const WAYSTAR_PASS = process.env.WAYSTAR_PASS;

function connectSftp() {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn.on('ready', () => {
      conn.sftp((err, sftp) => {
        if (err) { conn.end(); return reject(err); }
        resolve({ conn, sftp });
      });
    });
    conn.on('error', err => reject(new Error(`SSH connection failed: ${err.message}`)));
    conn.connect({
      host: WAYSTAR_HOST, port: 22,
      username: WAYSTAR_USER, password: WAYSTAR_PASS,
      readyTimeout: 30000,
    });
  });
}

function readdir(sftp, dir) {
  return new Promise((resolve, reject) => {
    sftp.readdir(dir, (err, list) => {
      if (err) return reject(new Error(`readdir ${dir} failed: ${err.message}`));
      resolve(list);
    });
  });
}

function readFile(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const stream = sftp.createReadStream(remotePath, { encoding: 'utf8' });
    stream.on('data', c => buf += c);
    stream.on('end', () => resolve(buf));
    stream.on('error', reject);
  });
}

async function main() {
  console.log('=== SFTP RECON (read-only) ===');
  const { conn, sftp } = await connectSftp();
  console.log('Connected.\n');

  // 1. List root directory to discover folder names
  console.log('--- ROOT DIRECTORY ---');
  let rootList = [];
  try {
    rootList = await readdir(sftp, '/');
    for (const f of rootList) {
      const isDir = f.attrs && f.attrs.isDirectory && f.attrs.isDirectory();
      console.log(`${isDir ? '[DIR] ' : '[file]'} ${f.filename}`);
    }
  } catch (e) { console.log(`root readdir error: ${e.message}`); }
  console.log('');

  // 2. Probe likely upload folder names for 837 files
  const candidates = ['/Upload', '/upload', '/Uploads', '/Outbound', '/outbound', '/Sent', '/837'];
  // also add any dirs discovered at root
  for (const f of rootList) {
    const isDir = f.attrs && f.attrs.isDirectory && f.attrs.isDirectory();
    if (isDir && !candidates.includes('/' + f.filename)) candidates.push('/' + f.filename);
  }

  let found837 = null;
  for (const dir of candidates) {
    let list;
    try { list = await readdir(sftp, dir); }
    catch { continue; } // folder doesn't exist, skip silently
    console.log(`--- ${dir} (${list.length} files) ---`);
    const names = list.map(f => f.filename);
    console.log('Sample names: ' + names.slice(0, 15).join(', '));

    // Heuristics for an 837 claim file
    const cand = list.find(f => /837/i.test(f.filename) || /\.CLM|\.claim|\.txt$/i.test(f.filename));
    if (cand && !found837) {
      found837 = `${dir}/${cand.filename}`.replace('//', '/');
    }
    console.log('');
  }

  // 3. Dump the structure of one 837 (first ~2500 chars), if found
  if (found837) {
    console.log(`=== DUMPING 837 STRUCTURE: ${found837} ===`);
    try {
      const content = await readFile(sftp, found837);
      console.log(`Length: ${content.length} bytes\n`);
      console.log('--- FIRST 2500 CHARS ---');
      console.log(content.substring(0, 2500));
      console.log('\n--- SEGMENT IDS PRESENT ---');
      const segTerm = content[105] || '~';
      const elemSep = content[3] || '*';
      const ids = [...new Set(content.split(segTerm)
        .map(s => s.trim().split(elemSep)[0]).filter(Boolean))];
      console.log(`elemSep="${elemSep}" segTerm="${segTerm}"`);
      console.log('Segment IDs: ' + ids.join(', '));
    } catch (e) { console.log(`read error: ${e.message}`); }
  } else {
    console.log('No obvious 837 file found in probed folders.');
    console.log('Review the folder listings above to identify where 837s live.');
  }

  conn.end();
  console.log('\n=== RECON DONE ===');
}

main().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
