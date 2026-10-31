/* Backyard One-Dayer — match-day scorer (Firebase Realtime Database edition) */
const firebaseConfig = {
  apiKey: "AIzaSyBR_Z-sYQ0iRaRhsUlSU7fwfDBswjDnAwU",
  authDomain: "annual-backyard-one-dayer.firebaseapp.com",
  databaseURL: "https://annual-backyard-one-dayer-default-rtdb.firebaseio.com",
  projectId: "annual-backyard-one-dayer",
  storageBucket: "annual-backyard-one-dayer.firebasestorage.app",
  messagingSenderId: "663366620414",
  appId: "1:663366620414:web:6a099ddb52f830d69f01af"
};

const HOW = ['Bowled','Caught','Caught & bowled','LBW','Stumped','Run out','Hit wicket'];
const NEEDS_FIELDER = {'Caught':1,'Stumped':1,'Run out':1};
const $app = document.getElementById('app'), $strip = document.getElementById('strip');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const other = t => t === 'Green' ? 'Blue' : 'Green';
const ord = n => n + (['th','st','nd','rd'][(n%100>10&&n%100<14)?0:(n%10<4?n%10:0)] || 'th');
const clone = o => JSON.parse(JSON.stringify(o));
const lsGet = k => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch(e) { return null; } };
const lsSet = (k,v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch(e) {} };
const arr = v => Array.isArray(v) ? v : (v && typeof v === 'object' ? Object.keys(v).sort((a,b)=>a-b).map(k=>v[k]) : []);

let db = null, auth = null, me = null;   // me = signed-in scorer user
let canWrite = false, saveState = 'saved';
let players = [], matches = [], VOTES = {};
let M = null, D = null, V = 'home', UI = {};
let loaded = {players:false, matches:false};

/* ---------------- Realtime Database tidy-up (it drops empty arrays and nulls) ---------------- */
function normalize(m){
  if (!m) return m;
  m.teams = m.teams || {}; m.teams.Green = arr(m.teams.Green); m.teams.Blue = arr(m.teams.Blue);
  m.debutants = arr(m.debutants); m.wicketsToEnd = m.wicketsToEnd || {Green:1, Blue:1};
  m.innings = arr(m.innings).map(i => {
    i.batters = arr(i.batters); i.crease = arr(i.crease); i.complete = !!i.complete;
    i.overs = arr(i.overs).map(o => ({...o, bowler:o.bowler||'', lines:arr(o.lines).map(l=>({b:l.b, runs:l.runs||0, balls:l.balls==null?null:l.balls})), wkts:arr(o.wkts).map(w=>({...w, fielder:w.fielder||'', newIdx:w.newIdx==null?null:w.newIdx})), newBatters:arr(o.newBatters), creaseBefore:arr(o.creaseBefore), added:o.added||0}));
    if (i.card) i.card = arr(i.card).map(c=>({fielder:'', bowler:'', ...c}));
    return i;
  });
  m.potm = m.potm || {}; m.potm.votes = arr(m.potm.votes);
  return m;
}

/* ---------------- persistence ---------------- */
let saveChain = Promise.resolve();
function persistLocal(){ if (!M) return; lsSet('match_'+M.id, M); lsSet('draft_'+M.id, D); }
function save(){
  if (!M) return;
  persistLocal();
  if (!db || !canWrite) return;
  const body = clone(M);
  saveState = 'saving'; paintSave();
  saveChain = saveChain.then(() => db.ref('matches/'+M.id).set(body)).then(() => { saveState = 'saved'; paintSave(); })
    .catch(e => { saveState = 'error'; UI.permErr = /permission/i.test(String(e && e.message)); paintSave(); });
}
function savePlayers(){ if (db && canWrite) saveChain = saveChain.then(() => db.ref('players').set(players)).catch(()=>{}); }
function paintSave(){
  const el = document.getElementById('savestate'); if (!el) return;
  if (!canWrite) { el.textContent = ''; return; }
  el.textContent = {saving:'Saving…', saved:'Saved', error: UI.permErr ? 'Couldn’t save: database rules not set up' : 'Couldn’t save online — kept on this device'}[saveState] || '';
  el.style.color = saveState === 'error' ? 'var(--danger)' : 'var(--muted)';
}

/* ---------------- derived figures ---------------- */
function innTeam(k){ return k % 2 === 0 ? M.battingFirst : other(M.battingFirst); }
function curInn(){ return M.innings[M.innings.length-1]; }
function isCur(inn){ return inn === curInn() && M.status === 'live' && !inn.complete; }
function overList(inn){ return (D && isCur(inn) && canWrite) ? inn.overs.concat([D]) : inn.overs; }
function histFigures(inn){
  const bat = inn.card.map((c,i) => ({name:c.name, pos:i+1, runs:+c.runs||0, balls:0, bk:false, out: c.how==='Not out' ? null : {how:c.how, fielder:c.fielder, bowler:c.bowler}}));
  const bowl = {}, order = [];
  bat.forEach(b => { const o = b.out; if (!o || !o.bowler || o.how==='Run out' || o.how==='Unknown') return; if (!bowl[o.bowler]) { bowl[o.bowler] = {name:o.bowler, overs:null, runs:null, wkts:0, maidens:null}; order.push(o.bowler); } bowl[o.bowler].wkts++; });
  return {bat, bowl: order.map(n=>bowl[n]), runs: bat.reduce((a,b)=>a+b.runs,0), wkts: bat.filter(b=>b.out).length, overs:null};
}
function innFigures(inn){
  if (inn.card) return histFigures(inn);
  const withDraft = D && isCur(inn) && canWrite;
  const names = inn.batters.concat(withDraft ? D.newBatters : []);
  const bat = names.map((n,i) => ({name:n, pos:i+1, runs:0, balls:0, bk:false, out:null}));
  const bowl = {}, bowlOrder = [];
  overList(inn).forEach(o => {
    if (!o.bowler) return countLines(o, bat, null);
    if (!bowl[o.bowler]) { bowl[o.bowler] = {name:o.bowler, overs:0, runs:0, wkts:0, maidens:0}; bowlOrder.push(o.bowler); }
    const bw = bowl[o.bowler]; if (o !== D) bw.overs++;
    const r = countLines(o, bat, bw);
    if (o !== D && r === 0) bw.maidens++;
  });
  overList(inn).forEach(o => o.wkts.forEach(w => { if (bat[w.b]) bat[w.b].out = w; if (w.how !== 'Run out' && bowl[w.bowler]) bowl[w.bowler].wkts++; }));
  const runs = bat.reduce((a,b)=>a+b.runs,0), wkts = bat.filter(b=>b.out).length;
  return {bat, bowl: bowlOrder.map(n=>bowl[n]), runs, wkts, overs: inn.overs.length};
}
function countLines(o, bat, bw){ let r = 0; o.lines.forEach(l => { const b = bat[l.b]; if (!b) return; b.runs += +l.runs||0; r += +l.runs||0; if (l.balls != null && l.balls !== '') { b.balls += +l.balls; b.bk = true; } }); if (bw) bw.runs += r; return r; }
function teamTotal(team){ return M.innings.filter(i=>i.team===team).reduce((a,i)=>a+innFigures(i).runs,0); }
function matchBowling(name){ let o=0,r=0,w=0; M.innings.forEach(i => innFigures(i).bowl.forEach(b => { if (b.name===name){o+=b.overs||0;r+=b.runs||0;w+=b.wkts;} })); return {o,r,w}; }
function isFinalInnings(inn){ return M.innings.indexOf(inn) === M.inningsPerSide*2 - 1; }
function result(){
  const g = teamTotal('Green'), b = teamTotal('Blue');
  if (g === b) return {winner:'Tie', margin:0, wkts:null, g, b};
  const winner = g > b ? 'Green' : 'Blue', last = M.innings[M.innings.length-1];
  let wkts = null;
  if (last && last.team === winner && winner !== M.battingFirst) wkts = Math.max(0, (M.wicketsToEnd[winner]||0) - innFigures(last).wkts);
  return {winner, margin: Math.abs(g-b), wkts, g, b};
}
function resultText(r){
  if (r.winner === 'Tie') return 'Match tied';
  if (r.wkts != null) return `${r.winner} won by ${r.wkts} wicket${r.wkts===1?'':'s'}`;
  return `${r.winner} won by ${r.margin} run${r.margin===1?'':'s'}`;
}
function leadText(team){
  if (M.status === 'complete') return resultText(result());
  const us = teamTotal(team), them = teamTotal(other(team)), inn = curInn();
  if (inn && inn.team === team && isFinalInnings(inn) && !inn.complete) { const need = them - us + 1; return need > 0 ? `${team} need ${need} to win` : `${team} have won`; }
  const d = us - them;
  return d > 0 ? `${team} lead by ${d}` : d < 0 ? `${team} trail by ${-d}` : 'Scores level';
}
function howText(w){
  if (!w) return 'not out';
  switch (w.how) {
    case 'Unknown': return 'out (not recorded)';
    case 'Caught': return `c ${w.fielder||'?'} b ${w.bowler}`;
    case 'Caught & bowled': return `c & b ${w.bowler}`;
    case 'Bowled': return `b ${w.bowler}`;
    case 'LBW': return `lbw b ${w.bowler}`;
    case 'Stumped': return `st ${w.fielder||'?'} b ${w.bowler}`;
    case 'Run out': return `run out (${w.fielder||'?'})`;
    case 'Hit wicket': return `hit wicket b ${w.bowler}`;
  } return w.how;
}
function fmtDate(d){ if (/^\d{4}-\d{2}-\d{2}$/.test(d||'')) { try { return new Date(d+'T12:00:00').toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short',year:'numeric'}); } catch(e) {} } return d||''; }
function withMatch(m, fn){ const keep = M; M = m; try { return fn(); } finally { M = keep; } }

/* ---------------- Player of the Match: impact score ---------------- */
function bigWkt(runs, mode){ if (mode === 'per10') return Math.floor(runs/10); if (mode === 'quarter') return runs >= 20 ? runs/4 : 0; return runs >= 30 ? 5 : 0; }
function careerBefore(m){
  // Best score and best innings haul for each player in earlier real matches (practice matches never count)
  const bestR = {}, bestW = {};
  matches.forEach(x => { const f = x.full;
    if (!f || f.practice || f.status !== 'complete' || f.id === m.id) return;
    if (!m.practice && !(+f.matchNo < +m.matchNo)) return;
    withMatch(f, () => f.innings.forEach(inn => { const fi = innFigures(inn), wc = {};
      fi.bat.forEach(b => { bestR[b.name] = Math.max(bestR[b.name] ?? 0, b.runs); const o = b.out; if (o && o.bowler && o.how !== 'Run out' && o.how !== 'Unknown') wc[o.bowler] = (wc[o.bowler]||0) + 1; });
      Object.keys(fi.bat.reduce((a,b)=>(a[b.name]=1,a),{})).forEach(n => bestW[n] = Math.max(bestW[n] ?? 0, 0));
      Object.entries(wc).forEach(([n,c]) => bestW[n] = Math.max(bestW[n] ?? 0, c)); }));
  });
  return {bestR, bestW};
}
function impact(m, opts = {}){
  const extras = opts.extras !== false;
  const cb = extras ? careerBefore(m) : {bestR:{}, bestW:{}};
  const vetR = new Set(Object.keys(cb.bestR)), vetW = new Set(Object.keys(cb.bestW));
  return withMatch(m, () => {
    if (!M || M.status !== 'complete' || !M.innings.length) return null;
    const r = result();
    const maxNo = Math.max(...M.innings.map(i=>i.no));
    const close = r.winner === 'Tie' || (r.wkts != null ? r.wkts <= 2 : r.margin <= 15);
    const wLast = close ? 1.5 : (r.wkts == null && r.margin <= 30 ? 1.25 : 1);
    const pts = {}, st = {}, team = {};
    const add = (n, v, k) => { if (!n) return; pts[n] = (pts[n]||0) + v; st[n] = st[n] || {r:0,w:0,f:0,notes:[]}; if (k) st[n][k[0]] += k[1]; };
    const note = (n, t) => { st[n] = st[n] || {r:0,w:0,f:0,notes:[]}; st[n].notes.push(t); };
    ['Green','Blue'].forEach(t => M.teams[t].forEach(n => team[n] = t));
    let incomplete = false;
    M.innings.forEach(inn => {
      const f = innFigures(inn), w = inn.no === maxNo ? wLast : 1, wc = {};
      f.bat.forEach((b, i) => {
        team[b.name] = team[b.name] || inn.team;
        add(b.name, (b.runs + (b.runs >= 10 && f.runs ? 20*b.runs/f.runs*Math.min(1, f.runs/100) : 0) + (b.runs>=50?10:0) + (b.runs>=100?15:0)) * w, ['r', b.runs]);
        if (extras && b.runs >= 20) {
          const nextBest = Math.max(0, ...f.bat.filter((_,j)=>j!==i).map(x=>x.runs));
          if (b.runs >= 30 && f.wkts >= 3 && b.runs >= 2.5 * nextBest) { add(b.name, 15 * w); note(b.name, `Lone hand: ${b.runs} when no one else passed ${nextBest}`); }
          const prev = cb.bestR[b.name];
          if (vetR.has(b.name) && b.runs > prev) { add(b.name, Math.min(30, 5 + 0.5*(b.runs-prev)) * w); note(b.name, `New personal best ${b.runs} (previous best ${prev})`); }
        }
        if (extras) cb.bestR[b.name] = Math.max(cb.bestR[b.name] ?? 0, b.runs);
        const o = b.out; if (!o) return;
        if (o.how === 'Unknown') { incomplete = true; return; }
        if (o.bowler && o.how !== 'Run out') { add(o.bowler, (20 + (b.pos<=3?5:0) + bigWkt(b.runs, opts.bigWkt)) * w, ['w',1]); team[o.bowler] = team[o.bowler] || other(inn.team); wc[o.bowler] = (wc[o.bowler]||0) + 1; }
        if (o.fielder && NEEDS_FIELDER[o.how]) { add(o.fielder, ((o.how==='Run out'?8:4) + (b.runs>=30?2:0)) * w, ['f',1]); team[o.fielder] = team[o.fielder] || other(inn.team); }
      });
      if (extras) Object.entries(wc).forEach(([n, c]) => {
        if (c >= 3 && c > f.wkts / 2) { add(n, 15 * w); note(n, `Took ${c} of the ${f.wkts} wickets in an innings`); }
        const prev = cb.bestW[n];
        if (vetW.has(n) && c >= 3 && c > prev) { add(n, Math.min(25, 8 + 5*(c-prev)) * w); note(n, `Best-ever innings haul: ${c} wickets (previous best ${prev})`); }
      });
      if (extras) { f.bat.forEach(b => cb.bestW[b.name] = Math.max(cb.bestW[b.name] ?? 0, 0)); Object.entries(wc).forEach(([n, c]) => cb.bestW[n] = Math.max(cb.bestW[n] ?? 0, c)); }
    });
    if (extras && opts.setup !== false && r.winner !== 'Tie') {
      // The winning side's decisive innings: the round where they gained most on the other team
      let best = null;
      M.innings.filter(i => i.team === r.winner).forEach(i => {
        const opp = M.innings.find(j => j.team !== r.winner && j.no === i.no); if (!opp) return;
        const gain = innFigures(i).runs - innFigures(opp).runs;
        if (gain > 0 && (!best || gain > best.gain)) best = {inn: i, gain};
      });
      if (best) {
        const bat = innFigures(best.inn).bat.slice().sort((x,y)=>y.runs-x.runs)[0];
        if (bat && bat.runs >= 30) { add(bat.name, 15); note(bat.name, `Set up the win: top score of ${bat.runs} in the innings that swung the match (${r.winner} gained ${best.gain} runs)`); }
      }
    }
    const rank = Object.keys(pts).map(n => ({name:n, pts:pts[n], team:team[n], ...st[n]})).sort((a,b)=>b.pts-a.pts);
    if (!rank.length) return null;
    let pick = rank[0], reason = '';
    if (r.winner !== 'Tie') {
      const bw = rank.find(x=>x.team===r.winner), bl = rank.find(x=>x.team!==r.winner);
      pick = bw || rank[0];
      if (bw && bl) {
        if (bl.pts >= 1.5*bw.pts) { pick = bl; reason = 'From the losing side: head and shoulders above anyone on the winning team.'; }
        else if (close && bl.pts >= 1.15*bw.pts) { pick = bl; reason = 'From the losing side: a match-winning effort in a close game.'; }
      }
    }
    return {pick, reason, top: opts.all ? rank.slice(0,6) : rank.slice(0,3), incomplete};
  });
}
function statLine(x){ const p = []; if (x.r) p.push(`${x.r} run${x.r===1?'':'s'}`); if (x.w) p.push(`${x.w} wicket${x.w===1?'':'s'}`); if (x.f) p.push(`${x.f} catch${x.f===1?'':'es'}/run out${x.f===1?'':'s'}`); return p.join(' · ') || '—'; }

/* ---------------- strip ---------------- */
function paintStrip(){
  if (!M || M.status === 'setup' || !M.innings.length || M.historic || !['score','card','openers','awards'].includes(V)) { $strip.hidden = true; return; }
  const inn = curInn(), f = innFigures(inn), team = inn.team;
  const crease = (D && isCur(inn) && canWrite) ? D.crease : inn.crease;
  const bats = crease.map(i => f.bat[i]).filter(Boolean);
  const bowler = (D && isCur(inn) && canWrite && D.bowler) ? D.bowler : (inn.overs.length ? inn.overs[inn.overs.length-1].bowler : '');
  const bf = bowler ? f.bowl.find(b=>b.name===bowler) : null;
  const overNo = inn.overs.length + (D && isCur(inn) && canWrite ? 1 : 0);
  $strip.hidden = false;
  $strip.innerHTML = `<div class="strip-in" role="status" aria-label="Live score">
    <div class="s-logo"><img src="img/logo-inverted.png" alt=""></div>
    <div class="s-team ${team}">${CAP(team,'cap-strip')}<span class="t">${esc(team)}</span><span class="sc">${f.wkts}/${f.runs}</span><span class="ov">${ord(inn.no)} inns · ${inn.complete ? 'complete' : 'over '+Math.max(overNo,1)}</span></div>
    <div class="s-bat">${bats.length ? bats.map(b=>`<div class="ln"><span>${esc(b.name)}</span><span><b>${b.runs}${b.out?'':'*'}</b>${b.bk?`<span class="bl">(${b.balls})</span>`:''}</span></div>`).join('') : '<div class="ln"><span>Innings complete</span></div>'}</div>
    <div class="s-bowl"><span class="lab">Bowling</span><span class="fig">${bowler ? `${esc(bowler)} <b>${bf?bf.wkts:0}–${bf?bf.runs:0}</b> <span style="color:var(--strip-muted)">(${bf?bf.overs:0} ov)</span>` : '—'}</span></div>
    <div class="s-lead">${esc(leadText(team))}</div>
  </div>`;
}

/* ---------------- views ---------------- */
function render(){
  const f = {home:vHome, login:vLogin, setup:vSetup, openers:vOpeners, score:vScore, card:vCard, awards:vAwards, vote:vVote, admin:vAdmin}[V] || vHome;
  $app.innerHTML = f();
  paintStrip(); paintSave();
  if (UI.focus) { const el = document.getElementById(UI.focus); if (el) el.focus(); UI.focus = null; }
  if (document.getElementById('qr')) drawQr();
}
const CAP = () => '';
const HERO = () => `<div class="hero-photo"><img class="hero-img" src="img/hero-pitch.jpg" alt="A One Dayer match in progress on the backyard pitch"><img class="hero-logo" src="img/logo.png" alt="Annual Backyard One Dayer"></div>`;
const LOGO = (cls, alt='Annual Backyard One Dayer') => `<picture class="${cls}"><source srcset="img/logo-inverted.png" media="(prefers-color-scheme: dark)"><img src="img/logo.png" alt="${alt}"></picture>`;
function topbar(title, sub){
  if (V === 'home') return `${HERO()}<span id="savestate" class="savestate muted" style="align-self:flex-end;margin-top:-10px"></span>`;
  if (M && M.practice && !['home','login','vote','admin'].includes(V)) sub = 'Practice · ' + (sub||'');
  return `<div class="row spread"><div class="row" style="gap:14px;flex-wrap:nowrap;min-width:0"><a href="#" data-act="home" class="logo-link" aria-label="All matches">${LOGO('logo-sm','')}</a><div style="min-width:0"><div class="eyebrow">${esc(sub||'Backyard One-Dayer')}</div><h1>${esc(title)}</h1></div></div>
  <div class="row"><span id="savestate" class="savestate muted"></span>${V!=='home'?`<button class="ghost" data-act="home">All matches</button>`:''}</div></div>`;
}

function vHome(){
  const rank = x => x.full && x.full.practice ? 1e9 : (+(x.full && x.full.matchNo) || 0);
  const list = matches.slice().sort((a,b)=>rank(b)-rank(a));
  const open = matches.find(m => m.full && m.full.voting === 'open');
  const done = matches.filter(m=>m.full && !m.full.practice && m.status==='complete');
  const w = {Green:0, Blue:0, Tie:0}; done.forEach(m => { try { w[withMatch(m.full, result).winner]++; } catch(e) {} });
  const needsSetup = canWrite && (UI.readDenied || (loaded.players && loaded.matches && (!players.length || !done.length)));
  return `${topbar('One-Dayer Scorer')}
  ${open ? `<div class="notice good row spread"><span><b>Players’ Player voting is open</b> for ${open.full.practice?'the practice match':'Match '+esc(open.full.matchNo)}.</span><a class="btnlink primary" href="#vote">Vote now</a></div>` : ''}
  ${needsSetup ? `<div class="notice warn row spread"><span>Finish setting up: publish the database rules and load your past matches.</span><button class="primary" data-act="view" data-v="admin">Finish setup</button></div>` : ''}
  ${done.length ? `<div class="card" style="gap:6px"><div class="eyebrow">Overall · ${done.length} matches</div>
      <div class="row" style="justify-content:center;gap:28px;flex-wrap:nowrap">
        <div class="tally-team">${CAP('Green','cap-lg')}<div style="text-align:center"><div class="teamtag Green" style="font-size:20px">Green</div><div class="tnum tally" style="color:var(--green)">${w.Green}</div></div></div>
        <div style="font-family:var(--display);font-size:28px;color:var(--muted)">v</div>
        <div class="tally-team"><div style="text-align:center"><div class="teamtag Blue" style="font-size:20px">Blue</div><div class="tnum tally" style="color:var(--blue)">${w.Blue}</div></div>${CAP('Blue','cap-lg')}</div>
      </div><div class="muted small" style="text-align:center">${w.Green===w.Blue?'All square':(w.Green>w.Blue?'Green':'Blue')+' lead the series'}${w.Tie?` · ${w.Tie} tied`:''}</div></div>` : ''}
  <div class="card"><div class="row spread"><h2>Matches</h2>${canWrite?`<div class="row"><button data-act="newpractice">Practice match</button><button class="primary big" data-act="newmatch">New match</button></div>`:''}</div>
  ${UI.readDenied ? '<p class="muted">The database isn’t open yet. The scorer needs to finish setup.</p>' : !loaded.matches ? '<p class="muted">Loading matches…</p>' : list.length ? `<div class="mlist">${list.map(m=>{ const s = m.summary||''; return `<div class="mitem"><div><b style="font-family:var(--display);font-size:20px">${m.full&&m.full.practice?'Practice':'Match '+esc((m.full&&m.full.matchNo)||'')}</b> <span class="muted small">${esc(fmtDate(m.date))}</span><br>${/^(Green|Blue) won/.test(s) ? `${CAP(s.split(' ')[0],'cap-xs')}<span class="teamtag ${s.split(' ')[0]}">${s.split(' ')[0]}</span> ${esc(s.slice(s.indexOf(' ')+1))}` : `<span class="small">${esc(s)}</span>`}</div>
     <div class="row">${m.full&&m.full.practice?'<span class="pill debut">Practice</span>':''}${m.status==='live'&&!(m.full&&m.full.practice)?'<span class="pill">Live</span>':''}<button data-act="open" data-id="${esc(m.id)}">${m.status!=='complete'&&canWrite?'Continue':m.status!=='complete'?'Watch live':'View'}</button>
     ${canWrite && m.full && m.full.practice ? (UI.del===m.id ? `<span class="small">Delete it?</span><button class="danger" data-act="dodel" data-id="${esc(m.id)}">Delete</button><button class="ghost" data-act="nodel">Keep</button>` : `<button class="ghost" data-act="askdel" data-id="${esc(m.id)}">Delete</button>`) : ''}</div></div>`; }).join('')}</div>`
    : `<p class="muted">No matches yet.</p>`}
  </div>
  <div class="row spread small muted"><span>${players.length} players on the books</span>
    ${canWrite ? `<span class="row"><span>Signed in as scorer</span><button class="ghost" data-act="view" data-v="admin">Setup</button><button class="ghost" data-act="signout">Sign out</button></span>` : `<button class="ghost" data-act="view" data-v="login">Scorer sign in</button>`}</div>`;
}

/* ---- login / admin ---- */
function vLogin(){
  return `${topbar('Scorer sign in')}
  <div class="card" style="max-width:440px"><p class="muted small">Only the scorer needs to sign in. Everyone else can watch and vote without an account.</p>
    <label class="field">Email<input type="email" id="l-email" autocomplete="username" value="${esc(UI.lemail||'')}"></label>
    <label class="field">Password<input type="password" id="l-pass" autocomplete="current-password"></label>
    ${UI.lerr?`<div class="err">${esc(UI.lerr)}</div>`:''}
    <div class="row"><button class="primary" data-act="login">Sign in</button></div></div>`;
}
function rulesText(uid){
  const S = `auth != null && auth.uid === '${uid}'`;
  return JSON.stringify({rules:{
    ".read": true,
    "players": {".write": S},
    "matches": {".write": S},
    "votes": {"$match": {".write": S, "$device": {
      ".write": `(!data.exists() && newData.exists() && root.child('matches').child($match).child('voting').val() === 'open') || (${S})`,
      ".validate": "!newData.exists() || (newData.child('name').isString() && newData.child('name').val().length < 60)"}}}
  }}, null, 2);
}
function vAdmin(){
  if (!canWrite) return vLogin();
  const done = matches.filter(m=>m.full && !m.full.practice && m.status==='complete').length;
  return `${topbar('Setup')}
  <div class="card"><h2>1. Database rules</h2>
    <p class="muted small">These let everyone watch and vote, but only your login can change scores. In Firebase, open <b>Realtime Database</b>, then the <b>Rules</b> tab. Replace everything there with the text below and click <b>Publish</b>. You only need to do this once.</p>
    <textarea id="rulesbox" readonly style="width:100%;min-height:220px;font-family:ui-monospace,Menlo,monospace;font-size:13px">${esc(rulesText(me.uid))}</textarea>
    <div class="row"><button data-act="copyrules">Copy rules</button><span id="copymsg" class="small muted"></span></div></div>
  <div class="card"><h2>2. Past matches and players</h2>
    <p class="muted small">Loads the 12 matches from 2014 to 2025 and the 27 players in heritage order. Safe to run again: it replaces the same records.</p>
    <p class="small">${done} past matches and ${players.length} players loaded.</p>
    ${UI.imp?`<div class="notice ${UI.imp.bad?'bad':'good'}">${esc(UI.imp.t)}</div>`:''}
    <div class="row"><button class="primary" data-act="import">Load past matches and players</button></div></div>`;
}
async function importHistory(){
  UI.imp = {t:'Loading…'}; render();
  try {
    const seed = await (await fetch('seed.json', {cache:'no-store'})).json();
    const upd = {players: seed.players};
    Object.values(seed.matches).forEach(m => upd['matches/'+m.id] = m);
    await db.ref().update(upd);
    UI.imp = {t:`Done: ${Object.keys(seed.matches).length} matches and ${seed.players.length} players loaded.`};
    loaded.players = loaded.matches = false; subscribe();
  } catch(e) {
    UI.imp = {bad:1, t: /permission/i.test(String(e && e.message)) ? 'Firebase refused the save. Publish the database rules in step 1 first, then try again.' : 'Something went wrong loading the history. Check the internet connection and try again.'};
  }
  render();
}

/* ---- setup ---- */
function setupDefaults(){ UI.s = {date: new Date().toISOString().slice(0,10), pick:{}, newp:[], wk:{Green:null,Blue:null}, ips:3, toss:null, q:'', err:'', practice:false}; }
function teamList(t){ const all = players.map(p=>p.name).concat(UI.s.newp); return all.filter(n=>UI.s.pick[n]===t); }
function suggestedWk(t){ return Math.max(1, teamList(t).length - 1); }
function wkFor(t){ return UI.s.wk[t] ?? suggestedWk(t); }
function vSetup(){
  const s = UI.s, year = (s.date||'').slice(0,4);
  const all = players.map(p=>p.name).concat(s.newp);
  const q = s.q.trim().toLowerCase();
  const shown = all.filter(n=>!q || n.toLowerCase().includes(q));
  const box = t => { const l = teamList(t); return `<div class="teambox ${t}"><div class="row spread"><span class="row" style="gap:10px">${CAP(t,'cap-md')}<span class="teamtag ${t}" style="font-size:22px">${t}</span></span><span class="tnum">${l.length} players</span></div>
     <div class="small">${l.length ? l.map(n=>esc(n)+(s.newp.includes(n)?' <span class="pill debut">Debut</span>':'')).join(', ') : '<span class="muted">No one picked yet</span>'}</div>
     <div class="row spread"><span class="small">Wickets to bowl ${t} out</span>
       <span class="stepper"><button aria-label="Fewer wickets" data-act="wk" data-t="${t}" data-d="-1">−</button><span class="v tnum">${wkFor(t)}</span><button aria-label="More wickets" data-act="wk" data-t="${t}" data-d="1">+</button></span></div>
     <div class="muted small">${l.length>1 ? `Suggested ${suggestedWk(t)} (${l.length} players). Change it if someone will bat twice.` : 'Pick at least 2 players.'}</div></div>`; };
  return `${topbar(s.practice ? 'Practice match setup' : 'Match setup', s.practice ? 'Practice · not saved to your records' : 'New match')}
  <div class="card">
    <label class="row" style="gap:8px;cursor:pointer"><input type="checkbox" id="s-practice" ${s.practice?'checked':''}> <span><b>Practice match</b> <span class="muted small">— kept separate from real matches, and new players aren’t added to the list</span></span></label>
    <div class="grid2">
    <label class="field">Match date<input type="date" id="s-date" value="${esc(s.date)}"></label>
    <label class="field">Innings per side<span class="stepper"><button aria-label="Fewer innings" data-act="ips" data-d="-1">−</button><span class="v tnum">${s.ips}</span><button aria-label="More innings" data-act="ips" data-d="1">+</button></span></label>
  </div><p class="muted small">You can end the match early or add another round of innings on the day.</p></div>
  <div class="card"><div class="row spread"><h2>Who’s playing</h2><span class="muted small">Tap Green or Blue next to each player</span></div>
    <div class="row"><input type="text" id="s-q" placeholder="Search players" value="${esc(s.q)}" style="flex:1"></div>
    <div class="listscroll"><div class="pick">${shown.map(n=>`<div class="nm"><span class="muted tnum small" style="min-width:28px">${s.newp.includes(n)?'New':'#'+(all.indexOf(n)+1)}</span><span>${esc(n)}</span>${s.newp.includes(n)?'<span class="pill debut">Debut '+esc(year)+'</span>':''}</div>
      <div class="seg"><button class="Green ${s.pick[n]==='Green'?'on':''}" data-act="pick" data-n="${esc(n)}" data-t="Green">Green</button><button class="Blue ${s.pick[n]==='Blue'?'on':''}" data-act="pick" data-n="${esc(n)}" data-t="Blue">Blue</button></div>`).join('') || '<span class="muted">No players match that search.</span><span></span>'}</div></div>
    <div class="row"><input type="text" id="s-new" placeholder="New player, e.g. A. Smith" style="flex:1"><button data-act="addp">Add new player</button></div>
    <span class="muted small">New players are marked as debutants for ${esc(year)} and added to the player list.</span>
  </div>
  <div class="teams2">${box('Green')}${box('Blue')}</div>
  <div class="card"><h2>Coin toss</h2><p class="muted small">Who’s batting first?</p>
    <div class="toss"><button class="Green ${s.toss==='Green'?'on':''}" data-act="toss" data-t="Green">${CAP('Green','cap-md')}Green bat</button><button class="Blue ${s.toss==='Blue'?'on':''}" data-act="toss" data-t="Blue">${CAP('Blue','cap-md')}Blue bat</button></div>
    ${s.err?`<div class="err">${esc(s.err)}</div>`:''}
    <div class="row"><button class="primary big" data-act="start">Start match</button></div>
  </div>`;
}
function startMatch(){
  const s = UI.s, year = +(s.date||'').slice(0,4);
  const g = teamList('Green'), b = teamList('Blue');
  const fail = m => { s.err = m; render(); };
  if (!year) return fail('Choose the match date.');
  if (g.length < 2 || b.length < 2) return fail('Each team needs at least 2 players.');
  if (!s.toss) return fail('Choose who bats first.');
  let id = String(year), k = 2;
  if (s.practice) { id = 'practice'; matches = matches.filter(m=>m.id!=='practice'); try { localStorage.removeItem('draft_practice'); } catch(e) {} if (db) db.ref('votes/practice').remove().catch(()=>{}); }
  else {
    while (matches.some(m=>m.id===id)) id = year+'-'+(k++);
    s.newp.filter(n=>s.pick[n]).forEach(n => { if (!players.some(p=>p.name===n)) players.push({name:n, debut:year}); });
    savePlayers();
  }
  M = {id, year, date:s.date, practice:!!s.practice, matchNo: s.practice ? null : 1 + Math.max(0, ...matches.filter(m=>m.full&&!m.full.practice).map(m=>+m.full.matchNo||0)),
       teams:{Green:g, Blue:b}, debutants:s.newp.filter(n=>s.pick[n]), wicketsToEnd:{Green:wkFor('Green'), Blue:wkFor('Blue')},
       inningsPerSide:s.ips, battingFirst:s.toss, status:'live', innings:[], potm:{votes:[]}, voting:'none'};
  D = null; UI.o = {}; V = 'openers'; save(); refreshListEntry(); render();
}
async function deleteMatch(id){
  matches = matches.filter(m=>m.id!==id);
  try { localStorage.removeItem('match_'+id); localStorage.removeItem('draft_'+id); } catch(e) {}
  if (db && canWrite) { try { await db.ref('matches/'+id).remove(); await db.ref('votes/'+id).remove(); } catch(e) {} }
}

/* ---- openers ---- */
function vOpeners(){
  const k = M.innings.length, team = innTeam(k), field = other(team), no = Math.floor(k/2)+1;
  if (!canWrite) return vCard();
  const o = UI.o || (UI.o = {});
  const opt = (list, sel, ph) => `<option value="">${ph}</option>` + list.map(n=>`<option ${n===sel?'selected':''}>${esc(n)}</option>`).join('');
  return `${topbar(`${team} — ${ord(no)} innings`, `${M.year} · Start of innings`)}
  <div class="card"><div class="grid2">
    <label class="field">Opening batter<select id="o-b1">${opt(M.teams[team], o.b1, 'Choose batter')}</select></label>
    <label class="field">Opening batter<select id="o-b2">${opt(M.teams[team], o.b2, 'Choose batter')}</select></label>
    <label class="field">First bowler (${field})<select id="o-bw">${opt(M.teams[field], o.bw, 'Choose bowler')}</select></label>
  </div>
  <p class="muted small">${team} are bowled out after ${M.wicketsToEnd[team]} wickets.</p>
  ${o.err?`<div class="err">${esc(o.err)}</div>`:''}
  <div class="row"><button class="primary big" data-act="openinn">Start innings</button>${M.innings.length?`<button data-act="undo">Undo last over</button>`:''}</div></div>`;
}
function openInnings(){
  const o = UI.o, k = M.innings.length, team = innTeam(k);
  o.b1 = document.getElementById('o-b1').value; o.b2 = document.getElementById('o-b2').value; o.bw = document.getElementById('o-bw').value;
  if (!o.b1 || !o.b2) { o.err = 'Choose both opening batters.'; return render(); }
  if (o.b1 === o.b2) { o.err = 'Choose two different openers.'; return render(); }
  if (!o.bw) { o.err = 'Choose the first bowler.'; return render(); }
  M.innings.push({no: Math.floor(k/2)+1, team, batters:[o.b1, o.b2], crease:[0,1], overs:[], complete:false});
  D = newDraft(o.bw); UI.o = {}; V = 'score'; save(); refreshListEntry(); render();
}
function newDraft(bowler){ const inn = curInn(); return {bowler: bowler||'', lines: inn.crease.map(b=>({b, runs:0, balls:null})), wkts:[], newBatters:[], creaseBefore:[...inn.crease], crease:[...inn.crease]}; }

/* ---- score ---- */
function wktsSoFar(){ return innFigures(curInn()).wkts; }
function vScore(){
  if (!canWrite || !M.innings.length) return canWrite ? vOpeners() : vCard();
  const inn = curInn(), team = inn.team, field = other(team);
  if (inn.complete) return vInningsDone();
  if (!D) D = newDraft('');
  const f = innFigures(inn), target = M.wicketsToEnd[team];
  const prevBowler = inn.overs.length ? inn.overs[inn.overs.length-1].bowler : '';
  const allOut = f.wkts >= target;
  const chaseWon = isFinalInnings(inn) && teamTotal(team) > teamTotal(field);
  const w = UI.w;
  const lines = D.lines.map((l,li) => { const b = f.bat[l.b]; const out = D.wkts.some(x=>x.b===l.b);
    return `<div class="bname ${out?'out':''}">${esc(b.name)}<span class="sub">${out?howText(b.out):'on '+(b.runs - (+l.runs||0))}${inn.batters.concat(D.newBatters).filter(n=>n===b.name).length>1?' · batting again':''}</span></div>
      <div><div class="cnt"><button aria-label="One fewer run for ${esc(b.name)}" data-act="adj" data-li="${li}" data-k="runs" data-d="-1">−</button><input type="number" inputmode="numeric" min="0" id="r-${li}" data-li="${li}" data-k="runs" value="${l.runs}" aria-label="Runs this over for ${esc(b.name)}"><button aria-label="One more run for ${esc(b.name)}" data-act="adj" data-li="${li}" data-k="runs" data-d="1">+</button></div>
        <div class="quick" style="margin-top:4px">${[4,6].map(x=>`<button data-act="adj" data-li="${li}" data-k="runs" data-d="${x}">+${x}</button>`).join('')}</div></div>
      <div class="cnt"><button aria-label="One fewer ball for ${esc(b.name)}" data-act="adj" data-li="${li}" data-k="balls" data-d="-1">−</button><input class="balls" type="number" inputmode="numeric" min="0" id="b-${li}" data-li="${li}" data-k="balls" value="${l.balls??''}" placeholder="–" aria-label="Balls faced this over by ${esc(b.name)}"><button aria-label="One more ball for ${esc(b.name)}" data-act="adj" data-li="${li}" data-k="balls" data-d="1">+</button></div>`; }).join('');
  const ballsSum = D.lines.reduce((a,l)=>a+(l.balls==null||l.balls===''?0:+l.balls),0), ballsAny = D.lines.some(l=>l.balls!=null&&l.balls!=='');
  const thisOver = D.lines.reduce((a,l)=>a+(+l.runs||0),0);
  return `${topbar(`${team} — ${ord(inn.no)} innings`, `${M.year} · Over ${inn.overs.length+1}`)}
  ${chaseWon ? `<div class="notice good row spread"><span><b>${team} have passed ${field}’s total.</b> Finish the over and end the match.</span><button class="primary" data-act="askend" data-what="match">End match</button></div>` : ''}
  <div class="card">
    <div class="row"><label class="field" style="flex:1;max-width:340px">Bowler (${field})<select id="d-bowler"><option value="">Choose bowler</option>${M.teams[field].map(n=>`<option ${n===D.bowler?'selected':''}>${esc(n)}</option>`).join('')}</select></label>
      ${D.bowler && D.bowler===prevBowler ? `<span class="notice warn small">${esc(D.bowler)} also bowled the last over</span>` : ''}
      ${D.bowler ? (()=>{const mb = matchBowling(D.bowler); return `<span class="muted small">Today: ${mb.w}–${mb.r} off ${mb.o} overs</span>`;})() : ''}</div>
    <div class="lines"><div class="hd">At the crease</div><div class="hd c">Runs this over</div><div class="hd c">Balls faced (optional)</div>${lines}</div>
    <div class="row spread small muted"><span>This over: <b class="tnum" style="color:var(--ink)">${thisOver}</b> runs${D.wkts.length?`, ${D.wkts.length} wicket${D.wkts.length>1?'s':''}`:''}</span>
      ${ballsAny && ballsSum !== 6 ? `<span class="notice warn" style="padding:3px 10px">Balls entered add up to ${ballsSum}, not 6</span>` : ''}</div>
    ${w ? wicketPanel(f, team, field, target) : ''}
    ${UI.err ? `<div class="err">${esc(UI.err)}</div>` : ''}
    ${UI.ask ? confirmBox() : ''}
    <div class="actions">
      ${!w && !allOut ? `<button class="danger" data-act="wicket">Wicket</button>` : ''}
      ${D.wkts.length && !w ? `<button data-act="undowk">Undo wicket</button>` : ''}
      <button data-act="undo">Undo last over</button>
      <button data-act="view" data-v="card">Full scorecard</button>
      <button class="ghost" data-act="askend" data-what="innings">End innings</button>
      <button class="primary big push" data-act="complete">${allOut ? 'Complete over — innings over' : 'Complete over'}</button>
    </div>
    ${allOut ? `<div class="notice warn">That’s ${target} wickets: ${team} are all out. Check the runs, then complete the over.</div>` : ''}
  </div>`;
}
function wicketPanel(f, team, field, target){
  const w = UI.w; const crease = D.crease.map(i=>f.bat[i]);
  const ends = wktsSoFar() + 1 >= target;
  const outOpts = crease.map(b=>`<button class="${w.b===f.bat.indexOf(b)?'on':''}" data-act="wsel" data-k="b" data-v="${f.bat.indexOf(b)}">${esc(b.name)}</button>`).join('');
  const atCrease = new Set(crease.map(b=>b.name)), batted = new Set(f.bat.map(b=>b.name));
  const nextOpts = M.teams[team].filter(n=>!atCrease.has(n)).map(n=>`<option ${n===w.next?'selected':''} value="${esc(n)}">${esc(n)}${batted.has(n)?' (bats again)':''}</option>`).join('');
  return `<div class="wpanel"><h3>Wicket</h3>
    <div><div class="small muted" style="margin-bottom:6px">Who’s out?</div><div class="chips">${outOpts}</div></div>
    <div class="grid2">
      <label class="field">How out<select id="w-how">${HOW.map(h=>`<option ${h===w.how?'selected':''}>${h}</option>`).join('')}</select></label>
      ${NEEDS_FIELDER[w.how] ? `<label class="field">${w.how==='Caught'?'Caught by':w.how==='Stumped'?'Stumped by':'Run out by'} (${field})<select id="w-f"><option value="">Choose fielder</option>${M.teams[field].map(n=>`<option ${n===w.fielder?'selected':''}>${esc(n)}</option>`).join('')}</select></label>` : ''}
      ${ends ? `<div class="notice warn">This wicket bowls ${team} out.</div>` : `<label class="field">Next batter in<select id="w-next"><option value="">Choose batter</option>${nextOpts}</select></label>`}
    </div>
    <span class="small muted">Make sure the out batter’s runs for this over are entered. The new batter gets their own row for the rest of the over.</span>
    ${w.err?`<div class="err">${esc(w.err)}</div>`:''}
    <div class="row"><button class="primary" data-act="wconfirm">Confirm wicket</button><button class="ghost" data-act="wcancel">Cancel</button></div></div>`;
}
function confirmBox(){
  const a = UI.ask;
  const msg = a === 'innings' ? `End ${curInn().team}’s innings now? This over will be completed first.` : a === 'match' ? 'End the match now? The current over will be completed first.' : a === 'undo' ? 'Undo the last completed over? It reopens so you can fix it.' : '';
  return `<div class="confirm"><span>${msg}</span><button class="primary" data-act="doask">Yes</button><button class="ghost" data-act="noask">Cancel</button></div>`;
}
function readDraftInputs(){ if (!D) return; const bw = document.getElementById('d-bowler'); if (bw) D.bowler = bw.value; }
function completeOver(){
  readDraftInputs();
  if (!D.bowler) { UI.err = 'Choose the bowler before completing the over.'; return false; }
  const inn = curInn();
  inn.overs.push({bowler:D.bowler, lines:D.lines.map(l=>({b:l.b, runs:+l.runs||0, balls:(l.balls===''||l.balls==null)?null:+l.balls})), wkts:D.wkts.map(w=>({b:w.b,how:w.how,fielder:w.fielder||'',bowler:w.bowler,newIdx:w.newIdx??null})), added:D.newBatters.length, newBatters:[...D.newBatters], creaseBefore:D.creaseBefore});
  inn.batters.push(...D.newBatters);
  inn.crease = D.crease;
  if (innFigures(inn).wkts >= M.wicketsToEnd[inn.team]) inn.complete = true;
  D = null; UI.err = '';
  return true;
}
function undoOver(){
  let inn = curInn();
  if (!inn) { D = null; UI.o = {}; V = 'openers'; return; }
  if (!inn.overs.length) { M.innings.pop(); D = null; UI.o = {}; V = 'openers'; return; }
  const o = inn.overs.pop();
  const names = o.added ? inn.batters.splice(inn.batters.length - o.added, o.added) : [];
  inn.crease = o.creaseBefore; inn.complete = false;
  if (M.status === 'complete') M.status = 'live';
  D = {bowler:o.bowler, lines:o.lines.map(l=>({...l})), wkts:[], newBatters:[], creaseBefore:[...o.creaseBefore], crease:[...o.creaseBefore]};
  let k = 0;
  o.wkts.forEach(w => {
    const prev = [...D.crease];
    if (w.newIdx != null) { D.newBatters.push(names[k++]); D.crease = D.crease.map(x=>x===w.b?w.newIdx:x); }
    else D.crease = D.crease.filter(x=>x!==w.b);
    D.wkts.push({...w, prevCrease:prev});
  });
  V = 'score';
}
function vInningsDone(){
  const inn = curInn(), f = innFigures(inn), k = M.innings.length, total = M.inningsPerSide*2;
  const more = k < total, nextTeam = innTeam(k), nextNo = Math.floor(k/2)+1;
  return `${topbar(`${inn.team} ${f.wkts}/${f.runs}`, `${M.year} · ${ord(inn.no)} innings complete`)}
  <div class="card"><p>${esc(leadText(inn.team))}. Match totals: Green ${teamTotal('Green')}, Blue ${teamTotal('Blue')}.</p>
    ${UI.ask ? confirmBox() : ''}
    <div class="row">${more ? `<button class="primary big" data-act="nextinn">Start ${nextTeam}’s ${ord(nextNo)} innings</button>` : `<button class="primary big" data-act="endmatch">Finish match</button><button data-act="addround">Play another round of innings</button>`}
    ${more ? `<button data-act="askend" data-what="match">End match now</button>` : ''}
    <button data-act="view" data-v="card">Full scorecard</button><button data-act="askundo">Undo last over</button></div></div>
  ${cardHtml(inn)}`;
}

/* ---- scorecard ---- */
function cardHtml(inn){
  const f = innFigures(inn);
  return `<div class="card"><div class="row spread"><h2 class="row" style="gap:10px">${CAP(inn.team,'cap-sm')}<span><span class="teamtag ${inn.team}">${inn.team}</span> · ${ord(inn.no)} innings</span></h2><span class="tnum" style="font-family:var(--display);font-size:26px;font-weight:700">${f.wkts}/${f.runs}</span></div>
  <div class="tablewrap"><table><thead><tr><th>#</th><th>Batter</th><th></th><th class="n">R</th><th class="n">B</th><th class="n">SR</th></tr></thead><tbody>
  ${f.bat.map(b=>`<tr><td class="tnum muted">${b.pos}</td><td>${esc(b.name)}</td><td class="howout">${esc(howText(b.out))}</td><td class="n"><b>${b.runs}</b></td><td class="n">${b.bk?b.balls:'–'}</td><td class="n">${b.bk&&b.balls?(b.runs/b.balls*100).toFixed(0):'–'}</td></tr>`).join('')}
  <tr class="tot"><td></td><td>Total</td><td class="howout">${f.overs==null?'':f.overs+' overs'}</td><td class="n">${f.runs}</td><td></td><td></td></tr></tbody></table></div>
  ${f.bowl.length ? `<div class="tablewrap"><table><thead><tr><th>Bowler</th><th class="n">O</th><th class="n">M</th><th class="n">R</th><th class="n">W</th><th class="n">Econ</th></tr></thead><tbody>
  ${f.bowl.map(b=>`<tr><td>${esc(b.name)}</td><td class="n">${b.overs??'–'}</td><td class="n">${b.maidens??'–'}</td><td class="n">${b.runs??'–'}</td><td class="n"><b>${b.wkts}</b></td><td class="n">${b.overs?(b.runs/b.overs).toFixed(1):'–'}</td></tr>`).join('')}</tbody></table></div>` : ''}
  ${inn.card ? '<p class="muted small">Scored before the app: runs and dismissals only. Balls faced and bowlers’ overs and runs weren’t recorded.</p>' : ''}</div>`;
}
function awardsBanner(){
  if (M.status !== 'complete') return '';
  const imp = impact(M), pp = M.playersPlayer;
  if (!imp && !pp) return '';
  return `<div class="awards">
    ${imp ? `<div class="award"><span class="eyebrow">Player of the Match</span><b>${esc(imp.pick.name)}</b><span class="small muted">${esc(statLine(imp.pick))}</span></div>` : ''}
    <div class="award"><span class="eyebrow">Players’ Player</span><b>${pp ? esc(pp) : '—'}</b><span class="small muted">${pp ? 'Voted by the players' : M.voting==='open' ? 'Voting is open' : M.historic ? 'Not recorded' : 'Not voted yet'}</span></div>
    <button data-act="view" data-v="awards">Awards details</button></div>`;
}
function vCard(){
  const r = result();
  const sel = Math.min(UI.tab ?? (M.innings.length-1), M.innings.length-1);
  const live = M.status !== 'complete';
  return `${topbar(`Green ${r.g} · Blue ${r.b}`, `${M.practice?'':'Match '+(M.matchNo||'')+' · '}${fmtDate(M.date)} · ${live ? (canWrite?'Scorecard':'Live') : resultText(r)}`)}
  ${!canWrite && live ? '<div class="notice good small">Live: updates at the end of each over.</div>' : ''}
  ${awardsBanner()}
  ${UI.msg ? `<div class="notice bad">${esc(UI.msg)}</div>` : ''}
  <div class="row">${canWrite && live ? `<button class="primary" data-act="view" data-v="score">Back to scoring</button>` : ''}
    ${canWrite && !live ? `<button data-act="view" data-v="awards">Awards</button>` : ''}
    <button data-act="export">Download match spreadsheet</button></div>
  ${M.innings.length ? `<div class="tabs">${M.innings.map((i,k)=>`<button class="${k===sel?'on':''}" data-act="tab" data-k="${k}">${i.team} ${ord(i.no)}</button>`).join('')}</div>${cardHtml(M.innings[sel])}` : '<div class="card"><p class="muted">No overs bowled yet.</p></div>'}`;
}

/* ---- awards (scorer + viewers) ---- */
function voteUrl(){ return location.origin + location.pathname + '#vote'; }
function tally(id){ const t = {}; Object.values(VOTES[id]||{}).forEach(v => { if (v && v.name) t[v.name] = (t[v.name]||0)+1; }); return Object.entries(t).sort((a,b)=>b[1]-a[1]); }
function vAwards(){
  const imp = impact(M), nv = Object.keys(VOTES[M.id]||{}).length;
  const rows = tally(M.id), top = rows.length ? rows[0][1] : 0, leaders = rows.filter(x=>x[1]===top).map(x=>x[0]);
  return `${topbar('Awards', `${M.practice?'':'Match '+(M.matchNo||'')+' · '}${resultText(result())}`)}
  <div class="card"><div class="row spread"><h2>Player of the Match</h2><span class="pill">Picked on the numbers</span></div>
    ${imp ? `<div class="bigmsg" style="padding:8px 0;text-align:left">${esc(imp.pick.name)}</div>
      ${imp.reason ? `<div class="notice warn small">${esc(imp.reason)}</div>` : ''}
      <div class="tablewrap"><table><thead><tr><th>Top three</th><th>Team</th><th>Contribution</th><th class="n">Points</th></tr></thead><tbody>
      ${imp.top.map(x=>`<tr><td><b>${esc(x.name)}</b></td><td><span class="row" style="gap:6px;flex-wrap:nowrap">${CAP(x.team,'cap-xs')}<span class="teamtag ${x.team}">${x.team}</span></span></td><td class="small">${esc(statLine(x))}${(x.notes||[]).map(t=>`<div class="muted" style="font-size:13px">★ ${esc(t)}</div>`).join('')}</td><td class="n">${Math.round(x.pts)}</td></tr>`).join('')}</tbody></table></div>
      <p class="muted small">Points: 1 per run, a bonus for a big share of the innings, 10 for a fifty and 15 more for a hundred; 20 per wicket (plus 5 for a top-three batter or one already on 30+); 4 per catch or stumping and 8 per run out, plus 2 if the batter had made 30 or more. Final-innings efforts count up to 1.5 times in a close match. A losing player only wins if they’re 50% clear of everyone on the winning side, or 15% clear in a close match.</p>
      ${imp.incomplete ? '<p class="small notice warn">Some dismissals weren’t recorded for this match, so this pick is based on incomplete records.</p>' : ''}`
      : '<p class="muted">Available once the match is finished.</p>'}
  </div>
  <div class="card"><div class="row spread"><h2>Players’ Player</h2><span class="pill">Voted by the players</span></div>
    ${M.playersPlayer ? `<div class="notice good">Players’ Player: <b>${esc(M.playersPlayer)}</b></div>` : ''}
    ${M.historic ? '<p class="muted">Not recorded for this match.</p>' : !canWrite ? (M.voting==='open' ? `<a class="btnlink primary" href="#vote">Vote now</a>` : '<p class="muted">Voting isn’t open.</p>') :
      M.voting === 'open' ? `<p>Voting is open. Everyone scans the code or opens the link on their phone: one vote per phone, and votes stay hidden until you close voting.</p>
        <div class="qrwrap"><div id="qr" aria-label="QR code for the voting link"></div><div style="display:flex;flex-direction:column;gap:8px;min-width:0"><code class="small" style="word-break:break-all">${esc(voteUrl())}</code><button data-act="copylink">Copy voting link</button><span id="copymsg" class="small muted"></span><span class="bigmsg" style="padding:0;text-align:left">${nv} vote${nv===1?'':'s'}</span></div></div>
        <div class="row"><button class="primary" data-act="closevote">Close voting and show result</button></div>`
      : M.voting === 'closed' ? `${rows.length ? rows.map(([n,c])=>`<div class="row" style="gap:12px"><span style="width:150px">${esc(n)}</span><div class="bar" style="width:${Math.max(4,c/top*55)}%"></div><span class="tnum">${c}</span></div>`).join('') : '<p class="muted">No votes were cast.</p>'}
        ${leaders.length > 1 ? `<p class="small">It’s a tie. Choose the winner:</p>` : ''}
        <div class="row">${leaders.map(n=>`<button class="${M.playersPlayer===n?'primary':''}" data-act="setpp" data-n="${esc(n)}">${M.playersPlayer===n?'Winner: ':'Make winner: '}${esc(n)}</button>`).join('')}<button class="ghost" data-act="openvote">Reopen voting</button></div>`
      : `<p class="muted">Open voting when the match is over. Everyone votes on their own phone: no app or account needed.</p><div class="row"><button class="primary" data-act="openvote">Open Players’ Player voting</button></div>`}
  </div>
  <div class="row"><button data-act="view" data-v="card">Scorecard</button></div>`;
}
function drawQr(){
  const el = document.getElementById('qr'); UI.qr = false;
  if (!el || typeof QRCode === 'undefined') return;
  el.innerHTML = ''; new QRCode(el, {text: voteUrl(), width: 180, height: 180, correctLevel: QRCode.CorrectLevel.M});
}
function deviceId(){ let d = lsGet('deviceId'); if (!d) { d = 'd' + Math.random().toString(36).slice(2) + Date.now().toString(36); lsSet('deviceId', d); } return d; }
function vVote(){
  const m = matches.map(x=>x.full).find(x => x && x.voting === 'open');
  const head = `${HERO()}<div class="vote-head"><h1>Players’ Player</h1><a class="btnlink ghost" href="#">See the scores</a></div>`;
  if (!loaded.matches) return head + '<div class="card"><p class="muted">Loading…</p></div>';
  if (!m) return head + `<div class="card"><p>Voting isn’t open right now. It opens at the end of the match.</p></div>`;
  const mine = (VOTES[m.id]||{})[deviceId()];
  if (mine) return head + `<div class="card"><div class="bigmsg">Thanks — vote in</div><p class="muted" style="text-align:center">You voted for <b>${esc(mine.name)}</b>. The result is revealed when the scorer closes voting.</p></div>`;
  const ps = m.teams.Green.map(n=>({n,t:'Green'})).concat(m.teams.Blue.map(n=>({n,t:'Blue'})));
  return head + `<div class="card"><p>${m.practice?'Practice match':'Match '+esc(m.matchNo)} · ${esc(withMatch(m, ()=>resultText(result())))}. Who was the best player on the day? One vote per phone.</p>
    ${UI.vpick ? `<div class="confirm"><span>Vote for <b>${esc(UI.vpick)}</b>?</span><button class="primary" data-act="castvote" data-id="${esc(m.id)}">Confirm vote</button><button class="ghost" data-act="vcancel">Change</button></div>` : ''}
    ${UI.verr ? `<div class="err">${esc(UI.verr)}</div>` : ''}
    <div class="votegrid">${ps.map(x=>`<button class="${x.t} ${UI.vpick===x.n?'on':''}" data-act="vpick" data-n="${esc(x.n)}">${esc(x.n)}</button>`).join('')}</div></div>`;
}

/* ---------------- export ---------------- */
function exportXlsx(){
  if (typeof XLSX === 'undefined') { alertMsg('The spreadsheet tool didn’t load. Check the internet connection and try again.'); return; }
  const r = result(), imp = impact(M);
  const inns = [['Year','Inns','Team','Bat Pos','Batter','How Out','Fielder','Bowler','Runs','Not Out','Balls Faced']];
  const bowl = [['Year','Inns','Batting Team','Bowler','Overs','Maidens','Runs','Wickets']];
  M.innings.forEach(i => { const f = innFigures(i);
    f.bat.forEach(b => inns.push([M.year, i.no, i.team, b.pos, b.name, b.out?b.out.how:'Not out', b.out&&(NEEDS_FIELDER[b.out.how]||b.out.how==='Caught & bowled')?(b.out.fielder||b.out.bowler):'', b.out&&b.out.how!=='Run out'?(b.out.bowler||''):'', b.runs, b.out?'':1, b.bk?b.balls:'']));
    f.bowl.forEach(b => bowl.push([M.year, i.no, i.team, b.name, b.overs??'', b.maidens??'', b.runs??'', b.wkts])); });
  const match = [['Year','Date','Batted First','Innings per Side','Green Total','Blue Total','Winner','Result','Player of the Match','Players’ Player'],
    [M.year, M.date, M.battingFirst, M.inningsPerSide, r.g, r.b, r.winner, resultText(r), imp?imp.pick.name:'', M.playersPlayer||'']];
  const team = [['Team','Players']].concat(['Green','Blue'].map(t=>[t, M.teams[t].join(', ')]));
  const deb = [['Player','Debut']].concat((M.debutants||[]).map(n=>[n, M.year]));
  const wb = XLSX.utils.book_new();
  [['Innings',inns],['Bowling',bowl],['Match',match],['Teams',team],['Debutants',deb]].forEach(([n,a]) => XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(a), n));
  XLSX.writeFile(wb, `One-Dayer ${M.practice?'practice':M.year} scorecard.xlsx`);
}
function alertMsg(t){ UI.msg = t; render(); }

/* ---------------- list helpers ---------------- */
function summaryOf(m){ try { return withMatch(m, () => m.practice ? 'Practice match' : m.status==='complete' ? resultText(result()) : 'In progress'); } catch(e) { return ''; } }
function refreshListEntry(){ if (!M) return; const e = {id:M.id, date:M.date, status:M.status, summary:summaryOf(M), full:M}; const i = matches.findIndex(m=>m.id===M.id); if (i>=0) matches[i] = e; else matches.push(e); }
function openMatch(id){
  const m = matches.find(x=>x.id===id); if (!m) return;
  M = clone(m.full); normalize(M); UI = {};
  D = canWrite ? (lsGet('draft_'+id) || null) : null;
  if (D && (!M.innings.length || curInn().complete || D.creaseBefore.join() !== curInn().crease.join())) D = null;
  V = M.status === 'complete' ? 'card' : (!M.innings.length ? 'openers' : (canWrite ? 'score' : 'card'));
  render();
}

/* ---------------- events ---------------- */
document.addEventListener('click', e => {
  const t = e.target.closest('[data-act]'); if (!t) return;
  const a = t.dataset.act;
  if (V === 'score') readDraftInputs();
  switch (a) {
    case 'home': V = 'home'; M = null; D = null; UI = {}; if (location.hash) history.replaceState(null,'',location.pathname); break;
    case 'newmatch': setupDefaults(); V = 'setup'; break;
    case 'newpractice': setupDefaults(); UI.s.practice = true; V = 'setup'; break;
    case 'askdel': UI.del = t.dataset.id; break;
    case 'nodel': UI.del = null; break;
    case 'dodel': UI.del = null; deleteMatch(t.dataset.id).then(render); break;
    case 'open': return openMatch(t.dataset.id);
    case 'login': return doLogin();
    case 'signout': auth && auth.signOut(); break;
    case 'import': return importHistory();
    case 'copyrules': copyText(document.getElementById('rulesbox').value, document.getElementById('rulesbox')); return;
    case 'copylink': copyText(voteUrl()); return;
    case 'pick': { const n = t.dataset.n; if (UI.s.pick[n] === t.dataset.t) delete UI.s.pick[n]; else UI.s.pick[n] = t.dataset.t; UI.s.err=''; break; }
    case 'wk': { const tm = t.dataset.t; UI.s.wk[tm] = Math.max(1, wkFor(tm) + +t.dataset.d); break; }
    case 'ips': UI.s.ips = Math.max(1, Math.min(6, UI.s.ips + +t.dataset.d)); break;
    case 'toss': UI.s.toss = t.dataset.t; UI.s.err=''; break;
    case 'addp': { const el = document.getElementById('s-new'); const n = (el.value||'').trim().replace(/\s+/g,' ');
      if (!n) { UI.s.err = 'Type the new player’s name first.'; break; }
      if (players.some(p=>p.name.toLowerCase()===n.toLowerCase()) || UI.s.newp.some(p=>p.toLowerCase()===n.toLowerCase())) { UI.s.err = `${n} is already on the list.`; break; }
      UI.s.newp.push(n); UI.s.q = ''; UI.s.err=''; UI.focus = 's-new'; break; }
    case 'start': return startMatch();
    case 'openinn': return openInnings();
    case 'adj': { const l = D.lines[+t.dataset.li], k = t.dataset.k; const cur = l[k]==null||l[k]===''?0:+l[k]; l[k] = Math.max(0, cur + +t.dataset.d); persistLocal(); break; }
    case 'wicket': if (!D.bowler) { UI.err = 'Choose the bowler first.'; break; } UI.err=''; UI.w = {b: D.crease.length===1?D.crease[0]:null, how:'Bowled', fielder:'', next:''}; break;
    case 'wsel': UI.w[t.dataset.k] = +t.dataset.v; break;
    case 'wcancel': UI.w = null; break;
    case 'wconfirm': return confirmWicket();
    case 'undowk': { const w = D.wkts.pop(); if (w) { if (w.newIdx != null) { D.lines = D.lines.filter(l=>l.b!==w.newIdx); D.newBatters.pop(); } D.crease = w.prevCrease; } persistLocal(); break; }
    case 'complete': { const inn = curInn(); if (completeOver()) { save(); refreshListEntry(); } if (!inn.complete && !UI.err) D = newDraft(''); break; }
    case 'askend': UI.ask = t.dataset.what; break;
    case 'askundo': UI.ask = 'undo'; break;
    case 'noask': UI.ask = null; break;
    case 'doask': { const w = UI.ask; UI.ask = null;
      if (w === 'undo') { undoOver(); save(); refreshListEntry(); break; }
      const inn = curInn();
      if (!inn.complete && D && (D.lines.some(l=>+l.runs) || D.wkts.length || D.bowler)) { if (!completeOver()) break; }
      inn.complete = true; D = null;
      if (w === 'match') { M.status = 'complete'; V = 'awards'; }
      save(); refreshListEntry(); break; }
    case 'undo': if (V === 'openers') { undoOver(); save(); } else UI.ask = 'undo'; break;
    case 'nextinn': UI.o = {}; V = 'openers'; break;
    case 'endmatch': M.status = 'complete'; V = 'awards'; save(); refreshListEntry(); break;
    case 'addround': M.inningsPerSide++; UI.o = {}; V = 'openers'; save(); break;
    case 'view': V = t.dataset.v; UI.tab = null; if (V==='score' && M && M.innings.length && !curInn().complete && !D) D = newDraft(''); if (V==='awards') UI.qr = true; break;
    case 'tab': UI.tab = +t.dataset.k; break;
    case 'export': exportXlsx(); return;
    case 'openvote': M.voting = 'open'; M.playersPlayer = null; save(); refreshListEntry(); UI.qr = true; break;
    case 'closevote': { M.voting = 'closed'; const rows = tally(M.id); if (rows.length && (rows.length === 1 || rows[0][1] > rows[1][1])) M.playersPlayer = rows[0][0]; save(); refreshListEntry(); break; }
    case 'setpp': M.playersPlayer = t.dataset.n; save(); refreshListEntry(); break;
    case 'vpick': UI.vpick = t.dataset.n; UI.verr = ''; break;
    case 'vcancel': UI.vpick = null; break;
    case 'castvote': return castVote(t.dataset.id);
  }
  render();
});
function copyText(txt, ta){
  const msg = document.getElementById('copymsg');
  navigator.clipboard.writeText(txt).then(()=>{ if (msg) msg.textContent = 'Copied.'; }).catch(()=>{ if (ta) { ta.select(); } if (msg) msg.textContent = 'Select the text and copy it.'; });
}
async function castVote(id){
  if (!UI.vpick) return;
  try { await db.ref('votes/'+id+'/'+deviceId()).set({name: UI.vpick, at: Date.now()}); UI.vpick = null; UI.verr = ''; VOTES[id] = VOTES[id] || {}; VOTES[id][deviceId()] = {name: '…'}; }
  catch(e) { UI.verr = 'Your vote didn’t go through. Voting may have closed, or this phone has already voted.'; }
  render();
}
async function doLogin(){
  const email = document.getElementById('l-email').value.trim(), pass = document.getElementById('l-pass').value;
  UI.lemail = email;
  if (!email || !pass) { UI.lerr = 'Enter your email and password.'; return render(); }
  try { await auth.signInWithEmailAndPassword(email, pass); UI.lerr = ''; V = 'home'; render(); }
  catch(e) { UI.lerr = /network/i.test(e.code||'') ? 'No internet connection. Try again when you’re back online.' : 'That email and password don’t match the scorer login.'; render(); }
}
function confirmWicket(){
  const w = UI.w, inn = curInn(), team = inn.team, target = M.wicketsToEnd[team];
  const howEl = document.getElementById('w-how'); if (howEl) w.how = howEl.value;
  const fEl = document.getElementById('w-f'); w.fielder = fEl ? fEl.value : '';
  const nEl = document.getElementById('w-next'); w.next = nEl ? nEl.value : '';
  const ends = wktsSoFar() + 1 >= target;
  if (w.b == null) { w.err = 'Choose who’s out.'; return render(); }
  if (NEEDS_FIELDER[w.how] && !w.fielder) { w.err = 'Choose the fielder.'; return render(); }
  if (!ends && !w.next) { w.err = 'Choose the next batter.'; return render(); }
  const rec = {b:w.b, how:w.how, fielder:w.how==='Caught & bowled'?D.bowler:w.fielder, bowler:D.bowler, prevCrease:[...D.crease], newIdx:null};
  if (!ends) { const idx = inn.batters.length + D.newBatters.length; D.newBatters.push(w.next); D.lines.push({b:idx, runs:0, balls:null}); D.crease = D.crease.map(x=>x===w.b?idx:x); rec.newIdx = idx; }
  else D.crease = D.crease.filter(x=>x!==w.b);
  D.wkts.push(rec); UI.w = null; persistLocal(); render();
}
document.addEventListener('change', e => {
  const t = e.target;
  if (t.id === 's-date') { UI.s.date = t.value; render(); }
  else if (t.id === 's-practice') { UI.s.practice = t.checked; render(); }
  else if (t.id === 'w-how') { UI.w.how = t.value; const f = document.getElementById('w-f'); UI.w.fielder = f?f.value:''; const n = document.getElementById('w-next'); UI.w.next = n?n.value:''; render(); }
  else if (t.id === 'w-f' && UI.w) UI.w.fielder = t.value;
  else if (t.id === 'w-next' && UI.w) UI.w.next = t.value;
  else if (t.id === 'd-bowler') { D.bowler = t.value; UI.err=''; persistLocal(); render(); }
  else if (t.id && t.id.startsWith('o-')) { UI.o = UI.o||{}; UI.o[t.id.slice(2)] = t.value; UI.o.err=''; }
});
document.addEventListener('input', e => {
  const t = e.target;
  if (t.id === 's-q') { UI.s.q = t.value; render(); const el = document.getElementById('s-q'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
  else if (t.dataset && t.dataset.li != null && D) { const l = D.lines[+t.dataset.li]; const v = t.value; l[t.dataset.k] = v === '' ? (t.dataset.k==='balls'?null:0) : Math.max(0, parseInt(v,10)||0); persistLocal(); paintStrip(); }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.id === 's-new') { e.preventDefault(); document.querySelector('[data-act="addp"]').click(); }
  if (e.key === 'Enter' && (e.target.id === 'l-pass' || e.target.id === 'l-email')) { e.preventDefault(); doLogin(); }
});
function route(){ if (location.hash === '#vote') { V = 'vote'; M = null; } else if (V === 'vote') V = 'home'; render(); }
window.addEventListener('hashchange', route);

function subscribe(){
  ['players','matches','votes'].forEach(k => db.ref(k).off());
  UI.readDenied = false;
  const denied = () => { loaded.players = loaded.matches = true; UI.readDenied = true; render(); };
  db.ref('players').on('value', s => { players = arr(s.val()); loaded.players = true; if (['home','admin'].includes(V)) render(); }, denied);
  db.ref('matches').on('value', s => {
    const all = s.val() || {};
    const keepId = (M && canWrite && ['setup','openers','score'].includes(V)) ? M.id : null;
    const next = [];
    Object.values(all).forEach(m => { if (!m || !m.id) return; normalize(m);
      if (m.id === keepId) { next.push({id:M.id, date:M.date, status:M.status, summary:summaryOf(M), full:M}); return; }
      next.push({id:m.id, date:m.date, status:m.status, summary:summaryOf(m), full:m}); });
    if (keepId && !next.some(x=>x.id===keepId)) next.push({id:M.id, date:M.date, status:M.status, summary:summaryOf(M), full:M});
    matches = next; loaded.matches = true;
    if (M && M.id !== keepId) { const fresh = matches.find(x=>x.id===M.id); if (fresh) { M = clone(fresh.full); normalize(M); } }
    if (['home','card','vote','awards','admin'].includes(V)) render();
  }, denied);
  db.ref('votes').on('value', s => { VOTES = s.val() || {}; if (['awards','vote'].includes(V)) render(); }, () => {});
}

/* ---------------- boot ---------------- */
(function boot(){
  if (location.hash === '#vote') V = 'vote';
  render();
  if (typeof firebase === 'undefined') { $app.insertAdjacentHTML('afterbegin', '<div class="notice bad">Couldn’t reach the scoring service. Check the internet connection and reload.</div>'); return; }
  firebase.initializeApp(firebaseConfig);
  db = firebase.database(); auth = firebase.auth();
  auth.onAuthStateChanged(u => {
    me = u; canWrite = !!u; if (db) subscribe();
    if (!u && ['setup','openers','score','admin'].includes(V)) { V = M ? 'card' : 'home'; }
    render();
  });
  subscribe();
})();
