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
  'Prefer': 'resolution=merge-duplicates'   // upsert: re-runs update in place
};

function connectSftp() {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn.on('ready', () => {
      conn.sftp((err, sftp) => { if (err) { conn.end(); return reject(err); } resolve({ conn, sftp }); });
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
  const csr = list.filter(f => /\.CLP\.277\.edi$/i.test(f.filename));
  console.log(`Found ${list.length} files: ${era.length} 835 remittances, ${csr.length} 277 claim-status`);
  const files = [];
  for (const f of era) {
    try { files.push({ kind: '835', name: f.filename, content: await readFile(sftp, `/Download/${f.filename}`) }); }
    catch (e) { console.error(`Error reading ${f.filename}: ${e.message}`); }
  }
  for (const f of csr) {
    try { files.push({ kind: '277', name: f.filename, content: await readFile(sftp, `/Download/${f.filename}`) }); }
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
  let lineSeq = 0;          // stable, increments per service line within the file
  let claim = null;         // current claim-level header
  let svc = null;           // current service line

  // push the finished service line (or a claim with no SVC lines) into records
  const pushSvc = () => {
    if (!svc) return;
    // distribute claim-level CAS only onto the first line to avoid double-count
    records.push({ ...svc });
    svc = null;
  };
  const pushClaim = () => {
    pushSvc();
    // if a claim had NO service line at all, still emit one row so it isn't lost
    if (claim && !claim._emittedAny) {
      lineSeq++;
      records.push({
        line_seq: lineSeq, claim_id: claim.claim_id, account: claim.account, payer: claim.payer,
        claim_status: claim.claim_status, billed: claim.billed, paid: claim.paid, allowed: 0,
        patient_resp: claim.patient_resp, adjustments: claim.adjustments, writeoff: claim.writeoff,
        units: 0, dos: null, posting_date: claim.posting_date, cpt_code: '', claim_type: 'OTHER',
        top_cas_group: claim.top_cas_group, top_cas_reason: claim.top_cas_reason,
        cas_detail: JSON.stringify(claim.cas), source_file: filename
      });
    }
    claim = null;
  };

  // finalize claim-level CAS aggregates onto the claim header object
  const finalizeClaimCas = (c) => {
    c.patient_resp = c.cas.filter(a => a.group === 'PR').reduce((s, a) => s + a.amount, 0);
    c.writeoff = c.cas.filter(a => a.group === 'CO' || a.group === 'OA').reduce((s, a) => s + a.amount, 0);
    c.adjustments = c.cas.reduce((s, a) => s + a.amount, 0);
    if (c.cas.length) {
      const top = [...c.cas].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))[0];
      c.top_cas_group = top.group; c.top_cas_reason = top.reason;
    }
  };

  for (const line of lines) {
    const s = line.split(elemSep);
    const id = s[0];

    if (id === 'N1' && s[1] === 'PR') payer = s[2] || '';
    if (id === 'BPR') checkDate = parseDate835(s[16]);

    if (id === 'CLP') {
      pushClaim();
      const claimId = s[1] || '';
      claim = {
        claim_id: claimId,
        account: (claimId.match(/^[A-Za-z]+/) || [''])[0],
        payer: payer,
        claim_status: s[2] || '',
        billed: parseFloat(s[3]) || 0,
        paid: parseFloat(s[4]) || 0,
        patient_resp: 0, adjustments: 0, writeoff: 0,
        posting_date: checkDate,
        top_cas_group: '', top_cas_reason: '',
        cas: [],
        _emittedAny: false
      };
    }

    if (!claim) continue;

    // claim-level CAS (before any SVC) attaches to claim; line-level CAS attaches to svc
    if (id === 'CAS') {
      const group = s[1];
      const target = svc ? svc._cas : claim.cas;
      for (let i = 2; i + 1 < s.length; i += 3) {
        const reason = s[i]; const amount = parseFloat(s[i + 1]) || 0;
        if (reason) target.push({ group, reason, amount });
      }
    }

    if (id === 'SVC') {
      pushSvc();                         // close previous line
      claim._emittedAny = true;
      lineSeq++;
      const cptRaw = s[1] || '';
      const parts = cptRaw.split('^');
      const cpt = parts.length > 1 ? parts[1] : cptRaw;
      svc = {
        line_seq: lineSeq,
        claim_id: claim.claim_id, account: claim.account, payer: claim.payer,
        claim_status: claim.claim_status,
        billed: parseFloat(s[2]) || 0,   // SVC02 = line charge
        paid: parseFloat(s[3]) || 0,     // SVC03 = line paid  (line-level, not claim CLP04)
        allowed: 0,
        units: parseFloat(s[5]) || 1,
        dos: null,
        posting_date: claim.posting_date,
        cpt_code: cpt, claim_type: '',
        patient_resp: 0, adjustments: 0, writeoff: 0,
        top_cas_group: '', top_cas_reason: '',
        source_file: filename,
        _cas: []
      };
    }

    if (id === 'DTM' && s[1] === '472' && svc) svc.dos = parseDate835(s[2]);
    if (id === 'AMT' && s[1] === 'B6' && svc) svc.allowed = parseFloat(s[2]) || 0;
  }
  pushClaim();

  // finalize each emitted service-line row: roll its own CAS, set claim_type, serialize cas
  for (const r of records) {
    if (r._cas) {
      r.patient_resp = r._cas.filter(a => a.group === 'PR').reduce((s, a) => s + a.amount, 0);
      r.writeoff = r._cas.filter(a => a.group === 'CO' || a.group === 'OA').reduce((s, a) => s + a.amount, 0);
      r.adjustments = r._cas.reduce((s, a) => s + a.amount, 0);
      if (r._cas.length) {
        const top = [...r._cas].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))[0];
        r.top_cas_group = top.group; r.top_cas_reason = top.reason;
      }
      r.cas_detail = JSON.stringify(r._cas);
      delete r._cas;
    }
    if (!r.cas_detail) r.cas_detail = '[]';
    const c = r.cpt_code;
    if (['G0480','G0481','G0482','G0483'].includes(c)) r.claim_type = 'TOX';
    else if (c === 'P9603') r.claim_type = 'TRAVEL';
    else if (c && c.startsWith('87')) r.claim_type = 'MOLECULAR';
    else if (c && /^(80|82|83|84|85|36)/.test(c)) r.claim_type = 'BLOOD';
    else r.claim_type = 'OTHER';
  }

  console.log(`Parsed ${records.length} service lines from ${filename}`);
  return records;
}

function parseDate835(d) {
  if (!d || d.length < 8) return null;
  return `${d.substring(0,4)}-${d.substring(4,6)}-${d.substring(6,8)}`;
}

// ── PARSE 277 CLAIM STATUS ────────────────────────────────────
function parse277(content, filename) {
  const records = [];
  if (!content || content.length < 106 || content.slice(0,3) !== 'ISA') {
    console.log(`Skipping ${filename}: not a valid 277`);
    return records;
  }
  const elemSep = content[3];
  const segTerm = content[105];
  const segs = content.split(segTerm).map(s => s.trim()).filter(Boolean);

  const statusLabel = (stc) => {
    const cat = (stc||'').split('^')[0];
    const map = {A0:'Acknowledged',A1:'Accepted',A2:'Accepted (forwarded)',A3:'Returned/Rejected',
      A4:'Rejected',A6:'Rejected (missing info)',A7:'Rejected (data error)',A8:'Rejected',
      P1:'Pending',P2:'Pending',P3:'Pending',P4:'Pending',
      F0:'Finalized',F1:'Finalized/Paid',F2:'Finalized/Denied',F3:'Finalized/Reversed',F4:'Finalized'};
    return map[cat] || cat || '';
  };
  const isRejected = (stc) => /^A[34678]/.test((stc||'').split('^')[0]);

  let fileDate = null, cur = null;
  const push = () => { if (cur && cur.claim_id) records.push(cur); cur = null; };

  for (const line of segs) {
    const s = line.split(elemSep);
    const id = s[0];
    if (id === 'BHT') fileDate = parseDate835(s[4]);
    if (id === 'NM1' && s[1] === 'QC') {
      push();
      cur = { claim_id:'', patient_last:s[3]||'', patient_first:s[4]||'',
        member_id:(s[8]==='MI'?(s[9]||''):''), status_code:'', status_label:'', rejected:false,
        status_date:null, dos:null, charge:0, account:'', source_file:filename };
    }
    if (!cur) continue;
    if (id === 'TRN' && s[1] === '2') {
      cur.claim_id = s[2] || '';
      cur.account = (cur.claim_id.match(/^[A-Za-z]+/)||[''])[0];
    }
    if (id === 'STC') {
      cur.status_code = s[1] || '';
      cur.status_label = statusLabel(s[1]);
      cur.rejected = isRejected(s[1]);
      cur.status_date = parseDate835(s[2]) || fileDate;
      cur.charge = parseFloat(s[4]) || 0;
    }
    if (id === 'DTP' && s[1] === '472') cur.dos = parseDate835((s[3]||'').split('-')[0]);
  }
  push();
  console.log(`Parsed ${records.length} claim-status records from ${filename}`);
  return records;
}

async function upsertClaims(records) {
  if (!records.length) { console.log('No claim-status records to upsert'); return { synced: 0, errors: 0 }; }
  const chunkSize = 500;
  let synced = 0, errors = 0;
  for (let i = 0; i < records.length; i += chunkSize) {
    const chunk = records.slice(i, i + chunkSize);
    console.log(`Upserting claims ${i}-${Math.min(i+chunkSize, records.length)} of ${records.length}...`);
    const res = await fetch(`${SUPABASE_URL}/rest/v1/claims?on_conflict=claim_id,source_file`, {
      method: 'POST', headers: SB_H,
      body: JSON.stringify(chunk.map(r => ({
        claim_id: r.claim_id, account: r.account,
        patient_last: r.patient_last, patient_first: r.patient_first, member_id: r.member_id,
        status_code: r.status_code, status_label: r.status_label, rejected: r.rejected,
        status_date: r.status_date, dos: r.dos, charge: r.charge, source_file: r.source_file
      })))
    });
    if (!res.ok) { console.error(`Claims chunk error: ${await res.text()}`); errors += chunk.length; }
    else synced += chunk.length;
  }
  return { synced, errors };
}

async function upsertPayments(records) {
  if (!records.length) { console.log('No records to upsert'); return { synced: 0, errors: 0 }; }
  const chunkSize = 500;
  let synced = 0, errors = 0;
  for (let i = 0; i < records.length; i += chunkSize) {
    const chunk = records.slice(i, i + chunkSize);
    console.log(`Upserting ${i}-${Math.min(i+chunkSize, records.length)} of ${records.length}...`);
    const res = await fetch(`${SUPABASE_URL}/rest/v1/payments?on_conflict=claim_id,cpt_code,source_file,line_seq`, {
      method: 'POST', headers: SB_H,
      body: JSON.stringify(chunk.map(r => ({
        line_seq: r.line_seq, claim_id: r.claim_id, account: r.account, payer: r.payer,
        claim_status: r.claim_status, billed: r.billed, paid: r.paid, allowed: r.allowed,
        patient_resp: r.patient_resp, adjustments: r.adjustments, writeoff: r.writeoff,
        units: r.units, dos: r.dos, posting_date: r.posting_date, cpt_code: r.cpt_code,
        claim_type: r.claim_type, top_cas_group: r.top_cas_group, top_cas_reason: r.top_cas_reason,
        cas_detail: r.cas_detail, source_file: r.source_file
      })))
    });
    if (!res.ok) { console.error(`Chunk error: ${await res.text()}`); errors += chunk.length; }
    else synced += chunk.length;
  }
  return { synced, errors };
}

async function main() {
  console.log('=== OM Labs Waystar 835 + 277 -> Supabase Sync ===');
  console.log(`Time: ${new Date().toISOString()}`);
  try {
    const files = await sftpDownload();
    console.log(`Downloaded ${files.length} files`);
    if (!files.length) { console.log('No files found'); return; }

    let payLines = [], claimRecs = [];
    for (const f of files) {
      if (f.kind === '835') payLines = payLines.concat(parse835(f.content, f.name));
      else if (f.kind === '277') claimRecs = claimRecs.concat(parse277(f.content, f.name));
    }
    console.log(`\nTotal: ${payLines.length} payment service-lines (835), ${claimRecs.length} claim-status records (277)`);

    const p = await upsertPayments(payLines);
    console.log(`835 → payments: ${p.synced} synced, ${p.errors} errors`);
    const c = await upsertClaims(claimRecs);
    console.log(`277 → claims:   ${c.synced} synced, ${c.errors} errors`);

    console.log(`✅ Done.`);
    if (p.errors > 0 || c.errors > 0) process.exit(1);
  } catch (e) {
    console.error(`❌ Sync failed: ${e.message}`);
    console.error(e.stack);
    process.exit(1);
  }
}
main();
