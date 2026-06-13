const { Client } = require('ssh2');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const WAYSTAR_HOST = process.env.WAYSTAR_HOST;
const WAYSTAR_USER = process.env.WAYSTAR_USER;
const WAYSTAR_PASS = process.env.WAYSTAR_PASS;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const SB_H = {
  'apikey': SUPABASE_KEY,
  'Authorization': 'Bearer ' + SUPABASE_KEY,
  'Content-Type': 'application/json',
  'Prefer': 'resolution=merge-duplicates'
};

// ── SFTP: list and download 835 files (SEQUENTIAL) ────────────
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
      host: WAYSTAR_HOST,
      port: 22,
      username: WAYSTAR_USER,
      password: WAYSTAR_PASS,
      readyTimeout: 30000,
    });
  });
}

function readdir(sftp, dir) {
  return new Promise((resolve, reject) => {
    sftp.readdir(dir, (err, list) => {
      if (err) return reject(new Error(`readdir failed: ${err.message}`));
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

async function sftpDownload() {
  const { conn, sftp } = await connectSftp();
  console.log('SFTP connected to Waystar');

  const remoteDir = '/Download';
  const list = await readdir(sftp, remoteDir);

  // Only real ERA files, and only regular files (skip dirs / stale entries)
  const era835 = list.filter(f => {
    const isFile = f.attrs && typeof f.attrs.isFile === 'function' ? f.attrs.isFile() : true;
    return isFile && /\.ERA\.835\.edi$/i.test(f.filename);
  });

  console.log(`Found ${list.length} files in /Download, ${era835.length} are 835/ERA files`);

  const files = [];
  // Sequential reads — concurrent reads on one channel cause "No response from server"
  for (const file of era835) {
    const remotePath = `${remoteDir}/${file.filename}`;
    try {
      const content = await readFile(sftp, remotePath);
      files.push({ name: file.filename, content });
    } catch (e) {
      console.error(`Error reading ${file.filename}: ${e.message}`);
    }
  }

  conn.end();
  return files;
}

// ── PARSE X12 835 ─────────────────────────────────────────────
function parse835(content, filename) {
  const records = [];

  if (!content || content.length < 106 || content.slice(0, 3) !== 'ISA') {
    console.log(`Skipping ${filename}: not a valid 835 (no ISA header)`);
    return records;
  }

  // X12 delimiters are defined by the ISA segment, not hardcoded.
  // ISA is fixed-width: element separator = char at index 3,
  // component separator = ISA16 (index 104), segment terminator = index 105.
  const elemSep = content[3];
  const segTerm = content[105];

  const lines = content.split(segTerm).map(l => l.trim()).filter(Boolean);

  let currentClaim = null;
  let currentPayer = '';
  let checkDate = null;
  let checkAmount = 0;

  for (const line of lines) {
    const segs = line.split(elemSep);
    const segId = segs[0];

    if (segId === 'N1' && segs[1] === 'PR') {
      currentPayer = segs[2] || '';
    }

    if (segId === 'BPR') {
      checkAmount = parseFloat(segs[2]) || 0;
      checkDate = segs[16] ? parseDate835(segs[16]) : null;
    }

    if (segId === 'CLP') {
      if (currentClaim) records.push(currentClaim);
      currentClaim = {
        claim_id:     segs[1] || '',
        payer:        currentPayer,
        claim_status: segs[2],            // 1=paid, 2=denied, 3=partial, 4=denied
        billed:       parseFloat(segs[3]) || 0,
        payments:     parseFloat(segs[4]) || 0,   // CLP04 = claim-level paid
        allowed:      parseFloat(segs[5]) || 0,
        adjustments:  0,
        writeoff:     0,
        dos:          null,
        posting_date: checkDate,
        account:      '',
        cpt_code:     '',
        claim_type:   '',
        payer_type:   '',
        source_file:  filename,
      };
    }

    if (segId === 'SVC' && currentClaim) {
      // Service line — capture first CPT only. Do NOT add SVC payment here:
      // CLP04 already holds the claim-level paid amount (avoids double-count).
      const cptRaw = segs[1] || '';
      const cpt = cptRaw.includes(':') ? cptRaw.split(':')[1] : cptRaw;
      if (cpt && !currentClaim.cpt_code) currentClaim.cpt_code = cpt;
    }

    if (segId === 'DTM' && segs[1] === '232' && currentClaim) {
      currentClaim.dos = parseDate835(segs[2]);
    }

    if (segId === 'CAS' && currentClaim) {
      // CAS: group code at segs[1], then repeating (reason, amount, qty) triplets
      // starting at segs[2]. Amounts are at index 3, 6, 9, ...
      let adjTotal = 0;
      for (let i = 3; i < segs.length; i += 3) {
        adjTotal += parseFloat(segs[i]) || 0;
      }
      currentClaim.adjustments += adjTotal;
      if (segs[1] === 'CO' || segs[1] === 'OA') {
        currentClaim.writeoff += adjTotal;
      }
    }
  }

  if (currentClaim) records.push(currentClaim);

  for (const r of records) {
    if (r.cpt_code === 'G0481' || r.cpt_code === 'G0480') r.claim_type = 'TOX';
    else if (r.cpt_code === 'P9603') r.claim_type = 'TRAVEL';
    else if (r.cpt_code && r.cpt_code.startsWith('87')) r.claim_type = 'MOLECULAR';
    else r.claim_type = 'BLOOD';
  }

  console.log(`Parsed ${records.length} claims from ${filename}`);
  return records;
}

function parseDate835(d) {
  if (!d || d.length < 8) return null;
  return `${d.substring(0,4)}-${d.substring(4,6)}-${d.substring(6,8)}`;
}

// ── UPSERT TO SUPABASE ────────────────────────────────────────
async function upsertPayments(records) {
  if (records.length === 0) { console.log('No records to upsert'); return { synced: 0, errors: 0 }; }

  const chunkSize = 500;
  let synced = 0, errors = 0;

  for (let i = 0; i < records.length; i += chunkSize) {
    const chunk = records.slice(i, i + chunkSize);
    console.log(`Upserting payments ${i}–${Math.min(i+chunkSize, records.length)} of ${records.length}…`);

    const res = await fetch(`${SUPABASE_URL}/rest/v1/payments?on_conflict=claim_id,source_file,cpt_code`, {
      method: 'POST',
      headers: SB_H,
      body: JSON.stringify(chunk.map(r => ({
        claim_id:     r.claim_id,
        dos:          r.dos,
        posting_date: r.posting_date,
        account:      r.account,
        claim_type:   r.claim_type,
        cpt_code:     r.cpt_code,
        payer:        r.payer,
        payer_type:   r.payer_type,
        billed:       r.billed,
        allowed:      r.allowed,
        payments:     r.payments,
        adjustments:  r.adjustments,
        writeoff:     r.writeoff,
        source_file:  r.source_file,
      })))
    });

    if (!res.ok) {
      console.error(`Chunk error: ${await res.text()}`);
      errors += chunk.length;
    } else {
      synced += chunk.length;
    }
  }

  return { synced, errors };
}

// ── MAIN ─────────────────────────────────────────────────────
async function main() {
  console.log('=== OM Labs Waystar 835 → Supabase Sync ===');
  console.log(`Time: ${new Date().toISOString()}`);

  try {
    const files = await sftpDownload();
    console.log(`Downloaded ${files.length} files`);

    if (files.length === 0) {
      console.log('No files found — check /Download folder on SFTP');
      return;
    }

    let allRecords = [];
    for (const file of files) {
      console.log(`\nParsing: ${file.name} (${file.content.length} bytes)`);
      console.log(`First 200 chars: ${file.content.substring(0, 200)}`);
      const records = parse835(file.content, file.name);
      allRecords = allRecords.concat(records);
    }

    console.log(`\nTotal claims parsed: ${allRecords.length}`);

    const { synced, errors } = await upsertPayments(allRecords);
    console.log(`✅ Done: ${synced} synced, ${errors} errors`);

    if (errors > 0) process.exit(1);

  } catch(e) {
    console.error(`❌ Sync failed: ${e.message}`);
    console.error(e.stack);
    process.exit(1);
  }
}

main();
