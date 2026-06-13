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

// ── SFTP: list and download 835 files ─────────────────────────
function sftpDownload() {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const files = [];

    conn.on('ready', () => {
      console.log('SFTP connected to Waystar');
      conn.sftp((err, sftp) => {
        if (err) { conn.end(); return reject(err); }

        const remoteDir = '/Download';
        sftp.readdir(remoteDir, (err, list) => {
          if (err) { conn.end(); return reject(new Error(`readdir failed: ${err.message}`)); }

          // Filter for 835 files only
          const era835 = list.filter(f =>
            f.filename.includes('835') ||
            f.filename.toLowerCase().includes('era') ||
            f.filename.toLowerCase().endsWith('.835') ||
            f.filename.toLowerCase().endsWith('.txt') ||
            f.filename.toLowerCase().endsWith('.x12')
          );

          console.log(`Found ${list.length} files in /Download, ${era835.length} are 835/ERA files`);
          if (era835.length === 0) {
            // If no obvious 835 files, download all files to inspect
            console.log('All files:', list.map(f => f.filename).join(', '));
          }

          const toDownload = era835.length > 0 ? era835 : list.slice(0, 5);
          let pending = toDownload.length;

          if (pending === 0) { conn.end(); return resolve([]); }

          for (const file of toDownload) {
            const remotePath = `${remoteDir}/${file.filename}`;
            let content = '';
            const stream = sftp.createReadStream(remotePath, { encoding: 'utf8' });
            stream.on('data', chunk => content += chunk);
            stream.on('end', () => {
              files.push({ name: file.filename, content });
              pending--;
              if (pending === 0) { conn.end(); resolve(files); }
            });
            stream.on('error', err => {
              console.error(`Error reading ${file.filename}: ${err.message}`);
              pending--;
              if (pending === 0) { conn.end(); resolve(files); }
            });
          }
        });
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

// ── PARSE X12 835 ─────────────────────────────────────────────
function parse835(content, filename) {
  const records = [];
  const lines = content.split(/[\r\n~]+/).map(l => l.trim()).filter(Boolean);

  let currentClaim = null;
  let currentPayer = '';
  let currentDOS = null;
  let checkDate = null;
  let checkAmount = 0;
  let claimType = '';

  for (const line of lines) {
    const segs = line.split('*');
    const segId = segs[0];

    if (segId === 'N1' && segs[1] === 'PR') {
      currentPayer = segs[2] || '';
    }

    if (segId === 'BPR') {
      checkAmount = parseFloat(segs[2]) || 0;
      checkDate = segs[16] ? parseDate835(segs[16]) : null;
    }

    if (segId === 'CLP') {
      // Save previous claim
      if (currentClaim) records.push(currentClaim);

      const claimStatus = segs[2]; // 1=paid, 2=denied, 3=partial
      currentClaim = {
        claim_id:        segs[1] || '',
        payer:           currentPayer,
        claim_status:    claimStatus,
        billed:          parseFloat(segs[3]) || 0,
        payments:        parseFloat(segs[4]) || 0,
        adjustments:     0,
        allowed:         parseFloat(segs[5]) || 0,
        writeoff:        0,
        dos:             null,
        posting_date:    checkDate,
        account:         '',
        cpt_code:        '',
        claim_type:      '',
        payer_type:      '',
        source_file:     filename,
      };
    }

    if (segId === 'NM1' && segs[1] === 'QC' && currentClaim) {
      // Patient name — helps identify account
    }

    if (segId === 'NM1' && segs[1] === '82' && currentClaim) {
      // Rendering provider
    }

    if (segId === 'SVC' && currentClaim) {
      // Service line — has CPT code
      const cptRaw = segs[1] || '';
      const cpt = cptRaw.includes(':') ? cptRaw.split(':')[1] : cptRaw;
      if (cpt && !currentClaim.cpt_code) currentClaim.cpt_code = cpt;
      currentClaim.payments += parseFloat(segs[3]) || 0;
    }

    if (segId === 'DTM' && segs[1] === '232' && currentClaim) {
      currentClaim.dos = parseDate835(segs[2]);
    }

    if (segId === 'CAS' && currentClaim) {
      // Adjustments
      let adjTotal = 0;
      for (let i = 3; i < segs.length; i += 3) {
        adjTotal += parseFloat(segs[i]) || 0;
      }
      currentClaim.adjustments += adjTotal;
      if (segs[1] === 'CO' || segs[1] === 'OA') {
        currentClaim.writeoff += adjTotal;
      }
    }

    if (segId === 'REF' && segs[1] === 'EA' && currentClaim) {
      // Medical record number — can help map to account
    }
  }

  if (currentClaim) records.push(currentClaim);

  // Determine claim type from CPT
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
  try {
    return `${d.substring(0,4)}-${d.substring(4,6)}-${d.substring(6,8)}`;
  } catch { return null; }
}

// ── UPSERT TO SUPABASE ────────────────────────────────────────
async function upsertPayments(records) {
  if (records.length === 0) { console.log('No records to upsert'); return { synced: 0, errors: 0 }; }

  const chunkSize = 500;
  let synced = 0, errors = 0;

  for (let i = 0; i < records.length; i += chunkSize) {
    const chunk = records.slice(i, i + chunkSize);
    console.log(`Upserting payments ${i}–${Math.min(i+chunkSize, records.length)} of ${records.length}…`);

    const res = await fetch(`${SUPABASE_URL}/rest/v1/payments`, {
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
    // 1. Download 835 files from Waystar SFTP
    const files = await sftpDownload();
    console.log(`Downloaded ${files.length} files`);

    if (files.length === 0) {
      console.log('No files found — check /Download folder on SFTP');
      return;
    }

    // 2. Parse each file
    let allRecords = [];
    for (const file of files) {
      console.log(`\nParsing: ${file.name} (${file.content.length} bytes)`);
      console.log(`First 200 chars: ${file.content.substring(0, 200)}`);
      const records = parse835(file.content, file.name);
      allRecords = allRecords.concat(records);
    }

    console.log(`\nTotal claims parsed: ${allRecords.length}`);

    // 3. Push to Supabase
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
