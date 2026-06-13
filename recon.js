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
  console.log('=== 835 CLAIM-BLOCK DUMP (read-only) ===');
  const { conn, sftp } = await connectSftp();
  console.log('Connected.\n');

  // Grab a recent 835 with real dollars. Pick a 13337.* file (those had paid claims).
  const list = await readdir(sftp, '/Download');
  const era = list
    .map(f => f.filename)
    .filter(n => /\.ERA\.835\.edi$/i.test(n))
    .sort();

  // Prefer a 13337 file from a date we know had money
  const target = era.find(n => /^13337\..*20260610/.test(n))
              || era.find(n => /^13337\./.test(n))
              || era[0];

  console.log(`Chosen file: ${target}\n`);
  const content = await readFile(sftp, `/Download/${target}`);

  const elemSep = content[3] || '|';
  const segTerm = content[105] || '~';
  console.log(`elemSep="${elemSep}"  segTerm="${segTerm}"  length=${content.length}\n`);

  const segs = content.split(segTerm).map(s => s.trim()).filter(Boolean);

  // Print every segment from file start through the end of the 2nd CLP claim block,
  // so we can see ISA/GS/ST/BPR/N1 headers + 2 full CLP..CLP claim blocks
  // (CLP, CAS, NM1, SVC, DTM, REF, AMT, etc).
  let clpCount = 0;
  console.log('--- SEGMENTS (header through 2nd claim block) ---');
  for (let i = 0; i < segs.length; i++) {
    const id = segs[i].split(elemSep)[0];
    if (id === 'CLP') {
      clpCount++;
      if (clpCount > 2) { console.log('...(stopping after 2 claim blocks)...'); break; }
    }
    console.log(segs[i]);
  }

  console.log('\n--- ALL UNIQUE SEGMENT IDS IN FILE ---');
  const ids = [...new Set(segs.map(s => s.split(elemSep)[0]))];
  console.log(ids.join(', '));

  // Also surface a denied/adjusted claim if one exists (CLP02 != 1)
  console.log('\n--- FIRST NON-PAID (denied/partial) CLAIM BLOCK, if any ---');
  let printing = false, printed = false;
  for (let i = 0; i < segs.length && !printed; i++) {
    const parts = segs[i].split(elemSep);
    if (parts[0] === 'CLP') {
      if (printing) { printed = true; break; }   // reached next claim, stop
      if (parts[2] && parts[2] !== '1') printing = true;  // status not "paid"
    }
    if (printing) console.log(segs[i]);
  }
  if (!printing && !printed) console.log('(no non-paid claim found in this file)');

  conn.end();
  console.log('\n=== DUMP DONE ===');
}

main().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
