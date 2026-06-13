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
  'Content-Type': 'application/json'
};

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
    conn.connect({ host: WAYSTAR_HOST, port: 22, username: WAYSTAR_USER, password: WAYSTAR_PASS, readyTimeout: 30000 });
  });
}
function readdir(sftp, dir) {
  return new Promise((resolve, reject) => {
    sftp.readdir(dir, (err, list) => err ? reject(new Error(`readdir failed: ${err.message}`)) : resolve(list));
  });
}
function readFile(sftp, p) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const s = sftp.createReadStream(p, { encoding: 'utf8' });
    s.on('data', c => buf += c); s.on('end', () => resolve(buf)); s.on('error', reject);
  });
}
async function sftpDownload() {
  const { conn, sftp } = await connectSftp();
  console.log('SFTP connected to Waystar');
  const list = await readdir(sftp, '/Download');
  const era = list.filter(f => /\.ERA\.835\.edi$/i.test(f.filename));
  console.log(`Found ${list.length} files in /Download, ${era.length} are 835/ERA files`);
  const files = [];
  for (const f of era) {
    try { files.push({ name: f.filename, content: await readFile(sftp, `/Download/${f.filename}`) }); }
    catch (e) { console.error(`Error reading ${f.filename}: ${e.message}`); }
  }
  conn.end();
  return files;
}

function parse835(content, filename) {
  const records = [];
  if (!content || content.length < 106 || content.slice(0, 3) !== 'ISA') {
    console.log(`Skipping ${filename}: not a valid 835`);
    return records;
  }
  const elemSep = content[3];
  const segTerm = content[105];
  const lines = content.split(segTerm).map(l => l.trim()).filter(Boolean);

  let payer = '';
  let checkDate = null;
  let cur = null;

  const finalize = (c) => {
    if (!c) return;
    c.patient_resp = c.cas.filter(a => a.group === 'PR').reduce((s, a) => s + a.amount, 0);
    c.writeoff = c.cas.filter(a => a.group === 'CO' || a.group === 'OA').reduce((s, a) => s + a.amount, 0);
    c.adjustments = c.cas.reduce((s, a) => s + a.amount, 0);
    if (c.cas.length) {
      const top = [...c.cas].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))[0];
      c.top_cas_group = top.group;
      c.top_cas_reason = top.reason;
    }
    c.cas_detail = JSON.stringify(c.cas);
    delete c.cas;
    records.push(c);
  };

  for (const line of lines) {
    const s = line.split(elemSep);
    const id = s[0];

    if (id === 'N1' && s[1] === 'PR') payer = s[2] || '';
    if (id === 'BPR') checkDate = parseDate835(s[16]);

    if (id === 'CLP') {
      finalize(cur);
      const claimId = s[1] || '';
      cur = {
        claim_id: claimId,
        account: (claimId.match(/^[A-Za-z]+/) || [''])[0],
        payer: payer,
        claim_status: s[2] || '',
        billed: parseFloat(s[3]) || 0,
        paid: parseFloat(s[4]) || 0,
        allowed: 0,
        patient_resp: 0,
        adjustments: 0,
        writeoff: 0,
        units: 0,
        dos: null,
        posting_date: checkDate,
        cpt_code: '',
        claim_type: '',
        top_cas_group: '',
        top_cas_reason: '',
        cas_detail: '[]',
        cas: [],
        source_file: filename,
      };
    }

    if (!cur) continue;

    if (id === 'SVC') {
      const cptRaw = s[1] || '';
      const parts = cptRaw.split('^');
      const cpt = parts.length > 1 ? parts[1] : cptRaw;
      if (cpt && !cur.cpt_code) cur.cpt_code = cpt;
      cur.units += parseFloat(s[5]) || 0;
    }
    if (id === 'DTM' && s[1] === '472') cur.dos = parseDate835(s[2]);
    if (id === 'AMT' && s[1] === 'B6') cur.allowed = parseFloat(s[2]) || 0;
    if (id === 'CAS') {
      const group = s[1];
      for (let i = 2; i + 1 < s.length; i += 3) {
        const reason = s[i];
        const amount = parseFloat(s[i + 1]) || 0;
        if (reason) cur.cas.push({ group, reason, amount });
      }
    }
  }
  finalize(cur);

  for (const r of records) {
    if (['G0480','G0481','G0482','G0483'].includes(r.cpt_code)) r.claim_type = 'TOX';
    else if (r.cpt_code === 'P9603') r.claim_type = 'TRAVEL';
    else if (r.cpt_code && r.cpt_code.startsWith('87')) r.claim_type = 'MOLECULAR';
    else if (r.cpt_code && /^(80|82|83|84|85|36)/.test(r.cpt_code)) r.claim_type = 'BLOOD';
    else r.claim_type = 'OTHER';
  }

  console.log(`Parsed ${records.length} claims from ${filename}`);
  return records;
}

function parseDate835(d) {
  if (!d || d.length < 8) return null;
  return `${d.substring(0,4)}-${d.substring(4,6)}-${d.substring(6,8)}`;
}

async function upsertPayments(records) {
  if (!records.length) { console.log('No records to upsert'); return { synced: 0, errors: 0 }; }
  const chunkSize = 500;
  let synced = 0, errors = 0;
  for (let i = 0; i < records.length; i += chunkSize) {
    const chunk = records.slice(i, i + chunkSize);
    console.log(`Upserting ${i}-${Math.min(i+chunkSize, records.length)} of ${records.length}...`);
    const res = await fetch(`${SUPABASE_URL}/rest/v1/payments`, {
      method: 'POST', headers: SB_H,
      body: JSON.stringify(chunk.map(r => ({
        claim_id: r.claim_id, account: r.account, payer: r.payer,
        claim_status: r.claim_status, billed: r.billed, paid: r.paid,
        allowed: r.allowed, patient_resp: r.patient_resp, adjustments: r.adjustments,
        writeoff: r.writeoff, units: r.units, dos: r.dos, posting_date: r.posting_date,
        cpt_code: r.cpt_code, claim_type: r.claim_type,
        top_cas_group: r.top_cas_group, top_cas_reason: r.top_cas_reason,
        cas_detail: r.cas_detail, source_file: r.source_file,
      })))
    });
    if (!res.ok) { console.error(`Chunk error: ${await res.text()}`); errors += chunk.length; }
    else synced += chunk.length;
  }
  return { synced, errors };
}

async function main() {
  console.log('=== OM Labs Waystar 835 -> Supabase Sync ===');
  console.log(`Time: ${new Date().toISOString()}`);
  try {
    const files = await sftpDownload();
    console.log(`Downloaded ${files.length} files`);
    if (!files.length) { console.log('No files found'); return; }
    let all = [];
    for (const f of files) all = all.concat(parse835(f.content, f.name));
    console.log(`\nTotal claims parsed: ${all.length}`);
    const { synced, errors } = await upsertPayments(all);
    console.log(`✅ Done: ${synced} synced, ${errors} errors`);
    if (errors > 0) process.exit(1);
  } catch (e) {
    console.error(`❌ Sync failed: ${e.message}`);
    console.error(e.stack);
    process.exit(1);
  }
}
main();
