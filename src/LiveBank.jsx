import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Chip, MenuItem, TextField } from '@mui/material';
import { ArrowLeftRight, Globe2, Landmark, List, LogOut, RefreshCw, Send, Users, Wallet, HandCoins, ChartNoAxesCombined, UserRound, Plus, Trash2 } from 'lucide-react';
import { toPaise } from './amount';
import { configuredEndpoint, liveApi, parseEndpoint, readStorage, saveStorage } from './live-api';
import { clearVeloraFirebaseSession, signInToVeloraFirebase, veloraApi } from './velora-api';
import './live.css';

const money = minor => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(minor / 100);
const time = value => value ? new Intl.DateTimeFormat('en-IN', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata',
}).format(new Date(value)) : '—';

const statusNames = {
  PENDING: 'Pending', PROCESSING: 'Processing', COMPLETED: 'Completed', REJECTED: 'Rejected', MANUAL_REVIEW: 'Manual review',
};
const rejectionNames = {
  INSUFFICIENT_FUNDS: 'Insufficient available balance',
  LIMIT_EXCEEDED: 'Transfer limit exceeded',
  DESTINATION_ACCOUNT_UNAVAILABLE: 'The destination is unavailable',
};
const byId = (directory, id) => directory.find(bank => bank.bankId === id)?.bankName || id;

function TransferForm({ bank, accounts, directory, send }) {
  const [type, setType] = useState('interbank');
  const [from, setFrom] = useState('');
  const [destination, setDestination] = useState('');
  const [number, setNumber] = useState('');
  const [amount, setAmount] = useState('200');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const sources = accounts.filter(account => account.status === 'ACTIVE');
  const fromId = sources.some(item => item.accountId === from) ? from : (sources[0]?.accountId || '');
  const routes = directory.filter(item => item.bankId !== bank.id && item.status === 'ACTIVE');
  const route = destination ? (routes.find(item => item.ifsc === destination)?.ifsc || '') : (routes[0]?.ifsc || '');
  const target = type === 'internal' ? bank.ifsc : route;

  async function submit(event) {
    event.preventDefault();
    setError('');
    const amountMinor = toPaise(amount);
    if (!fromId || !target || !number.trim() || amountMinor === null) {
      setError('Choose a source, destination and positive amount with at most two decimal places.');
      return;
    }
    setBusy(true);
    try {
      await send({ fromAccountId: fromId, destinationIfsc: target,
        destinationAccountNumber: number.trim(), amountMinor, currency: 'INR' });
      setNumber('');
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }

  return <section className="panel live-transfer"><header className="panel-head"><div>
    <h2>Send a test transfer</h2><p>Transfers use synthetic balances stored in Firestore.</p>
  </div><Send size={19} /></header>
    <form className="transfer-form" onSubmit={submit}>
      <div className="type-switch">
        {[['interbank', 'Interbank'], ['internal', 'Same bank']].map(([value, label]) => <Button key={value}
          type="button" aria-pressed={type === value} variant={type === value ? 'contained' : 'outlined'}
          disabled={busy} onClick={() => setType(value)}>{label}</Button>)}
      </div>
      <TextField select label="From account" required value={fromId} onChange={e => setFrom(e.target.value)} disabled={busy || !sources.length}>
        {sources.map(account => <MenuItem key={account.accountId} value={account.accountId}>
          {account.accountNumber} · {money(account.availableMinor)} available
        </MenuItem>)}
      </TextField>
      {type === 'interbank' && <TextField select label="Destination bank" required value={route}
        onChange={e => setDestination(e.target.value)} disabled={busy || !routes.length}>
        {routes.map(item => <MenuItem key={item.ifsc} value={item.ifsc}>{item.bankName} · {item.ifsc}</MenuItem>)}
      </TextField>}
      <TextField label="Destination account number" required value={number} onChange={e => setNumber(e.target.value)} disabled={busy} />
      <TextField label="Amount in INR" required value={amount} onChange={e => setAmount(e.target.value)} disabled={busy}
        slotProps={{ htmlInput: { inputMode: 'decimal' } }} />
      {error && <Alert severity="error">{error}</Alert>}
      <div><Button type="submit" variant="contained" disabled={busy || !fromId || !target} startIcon={<Send size={16} />}>
        {busy ? 'Submitting…' : 'Submit transfer'}
      </Button></div>
    </form>
  </section>;
}

function Activity({ rows, directory }) {
  return <section className="panel"><header className="panel-head"><div><h2>Transfer activity</h2><p>Latest 50 transfers for this user</p></div><List size={19} /></header>
    {rows.length ? <div className="table-scroll"><table>
      <thead><tr><th>Transfer</th><th>Route</th><th>Amount</th><th>Status</th></tr></thead>
      <tbody>{rows.map(row => <tr key={row.transferId}>
        <td><strong>{row.transferId}</strong><small>{time(row.createdAt)}</small></td>
        <td><strong>{byId(directory, row.sourceBankId)} → {byId(directory, row.destinationBankId)}</strong><small>
          {row.type === 'INTERNAL' ? 'Same bank' : row.direction === 'CREDIT' ? 'Incoming' : 'Outgoing'}
        </small></td>
        <td className={row.direction === 'CREDIT' ? 'incoming amount' : 'amount'}>{money(row.amountMinor)}</td>
        <td><Chip size="small" label={statusNames[row.status] || row.status}
          className={row.status === 'COMPLETED' ? 'completed' : 'live-' + row.status?.toLowerCase()} />
          {row.code && <small>{rejectionNames[row.code] || row.code.toLowerCase().replaceAll('_', ' ')}</small>}</td>
      </tr>)}</tbody>
    </table></div> : <div className="empty"><ArrowLeftRight size={23} /><strong>No transfers yet</strong><p>Your transfers appear here when the Worker accepts them.</p></div>}
  </section>;
}


function VeloraFeaturePage({ page, bankId, token, dashboard, onError, onNotice }) {
  const [items,setItems]=useState([]), [summary,setSummary]=useState(null), [loading,setLoading]=useState(true);
  const [search,setSearch]=useState(''), [showForm,setShowForm]=useState(false);
  const [form,setForm]=useState({name:'',accountNumber:'',ifsc:'',loanType:'PERSONAL',amount:'',tenureMonths:'12'});
  const paths={beneficiaries:'/beneficiaries',transactions:'/transactions',accounts:'/accounts',loans:'/loans',overview:'/analytics/overview',profile:'/profile'};
  const path=`/banks/${encodeURIComponent(bankId)}${paths[page]}`;
  const titles={beneficiaries:'Beneficiary management',transactions:'Transaction history',accounts:'My accounts',loans:'Loan applications',overview:'Financial overview',profile:'My profile'};
  const load=useCallback(async()=>{setLoading(true);try{if(!token)throw new Error('Individual Velora Firebase authentication is not available. Sign in again and check the Firebase configuration.');const r=await veloraApi(path,{token});if(['overview','profile'].includes(page))setSummary(r);else setItems(r[page]||r.items||r.transactions||r.accounts||r.loans||r.beneficiaries||[]);onError('');}catch(e){onError(e.message);setItems([]);setSummary(null);}finally{setLoading(false);}},[path,token,page,onError]);
  useEffect(()=>{load();},[load]);
  async function submit(e){e.preventDefault();let data=page==='beneficiaries'?{name:form.name.trim(),accountNumber:form.accountNumber,ifsc:form.ifsc.toUpperCase()}:{loanType:form.loanType,requestedMinor:Math.round(Number(form.amount)*100),tenureMonths:Number(form.tenureMonths)};
    try{await veloraApi(path,{token,data});setShowForm(false);onNotice('Your request was submitted.');await load();}catch(err){onError(err.message);}}
  const visible=items.filter(x=>JSON.stringify(x).toLowerCase().includes(search.toLowerCase()));
  return <section className="panel feature-page"><header className="panel-head"><div><h2>{titles[page]}</h2><p>Velora Bank · Secure customer services</p></div><button className="feature-refresh" onClick={load}><RefreshCw size={15}/> Refresh</button></header>
    {['beneficiaries','loans'].includes(page)&&<div className="feature-toolbar">{page==='beneficiaries'&&<input placeholder="Search records…" value={search} onChange={e=>setSearch(e.target.value)}/>}<button className="feature-primary" onClick={()=>setShowForm(!showForm)}><Plus size={15}/>{page==='loans'?'Apply for loan':'Add beneficiary'}</button></div>}
    {showForm&&<form className="feature-form" onSubmit={submit}>{page==='beneficiaries'?<><label>Name<input required value={form.name} onChange={e=>setForm({...form,name:e.target.value})}/></label><label>Account number<input required inputMode="text" autoCapitalize="characters" value={form.accountNumber} onChange={e=>setForm({...form,accountNumber:e.target.value.replace(/[^a-zA-Z0-9]/g,'').toUpperCase()})}/></label><label>IFSC<input required maxLength="11" value={form.ifsc} onChange={e=>setForm({...form,ifsc:e.target.value.toUpperCase()})}/></label></>:<><label>Loan type<select value={form.loanType} onChange={e=>setForm({...form,loanType:e.target.value})}><option>PERSONAL</option><option>HOME</option><option>EDUCATION</option><option>VEHICLE</option></select></label><label>Amount (INR)<input type="number" min="1" step=".01" required value={form.amount} onChange={e=>setForm({...form,amount:e.target.value})}/></label><label>Tenure months<input type="number" min="1" max="360" required value={form.tenureMonths} onChange={e=>setForm({...form,tenureMonths:e.target.value})}/></label></>}<button className="feature-primary">Submit</button></form>}
    {page==='overview'&&summary&&<div className="feature-metrics">{[['Available balance',summary.totalAvailableMinor],['Held balance',summary.totalHeldMinor],['Monthly credits',summary.monthlyCreditsMinor],['Monthly debits',summary.monthlyDebitsMinor]].map(([k,v])=><article key={k}><span>{k}</span><strong>{v==null?'—':money(v)}</strong></article>)}</div>}
    {page==='profile'&&summary&&<dl className="feature-profile">{Object.entries(summary.profile||summary).filter(([k,v])=>!['uid','passwordHash'].includes(k)&&['string','number'].includes(typeof v)).map(([k,v])=><React.Fragment key={k}><dt>{k.replace(/([A-Z])/g,' $1')}</dt><dd>{String(v)}</dd></React.Fragment>)}</dl>}
    {page==='accounts'&&!loading&&<div className="feature-list">{items.map((x,i)=><article className="feature-item" key={x.accountId||i}><Wallet/><div><strong>{x.accountNumber||x.accountId}</strong><span>{x.accountType||'Bank account'} · {x.status}</span></div><b>{money(x.availableMinor??0)}</b></article>)}</div>}
    {['beneficiaries','transactions','loans'].includes(page)&&!loading&&<div className="feature-list">{visible.map((x,i)=><article className="feature-item" key={x.beneficiaryId||x.transferId||x.loanId||x.id||i}><div><strong>{x.name||x.transferId||x.loanId||'Record'}</strong><span>{x.bankName||x.ifsc||x.status||x.type||''}</span><small>{x.accountNumber?'Account •••• '+String(x.accountNumber).slice(-4):x.createdAt?time(x.createdAt):''}</small></div><b>{x.amountMinor!=null?money(x.amountMinor):x.requestedMinor!=null?money(x.requestedMinor):''}</b>{page==='beneficiaries'&&<button type="button" className="feature-refresh" aria-label="Remove beneficiary" onClick={async()=>{try{await veloraApi(`/banks/${encodeURIComponent(bankId)}/beneficiaries/${encodeURIComponent(x.id||x.beneficiaryId)}`,{token,method:'DELETE'});onNotice('Beneficiary removed.');await load();}catch(err){onError(err.message);}}}><Trash2 size={15}/></button>}</article>)}{!visible.length&&<div className="feature-empty">No records returned by the bank API.</div>}</div>}
    {loading&&<div className="feature-empty">Loading {titles[page]}…</div>}
    {!loading&&!summary&&['overview','profile'].includes(page)&&<div className="feature-empty">No data returned by the bank API.</div>}
  </section>;
}

export default function LiveBank({ bank, switchUrl, openDemo }) {
  const urlKey = 'x42-cloudflare-worker-url';
  const [base, setBase] = useState(() => configuredEndpoint || readStorage(localStorage, urlKey, ''));
  const [session, setSession] = useState(null);
  const [veloraToken, setVeloraToken] = useState(null);
  const [activePage, setActivePage] = useState('dashboard');
  const prefix = '/banks/' + bank.id;
  const [url, setUrl] = useState(base);
  const [editUrl, setEditUrl] = useState(!base);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [data, setData] = useState({ accounts: [], transfers: [] });
  const [directory, setDirectory] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const activeToken = useRef(null);
  activeToken.current = session?.token;
  const pending = useRef(new Map());
  const refresh = useCallback(async signal => {
    if (!session) return;
    try {
      const value = await liveApi(base, prefix + '/dashboard', { token: session.token, signal });
      if (signal?.aborted || activeToken.current !== session.token) return;
      setData(value);
      setLoaded(true);
      setError('');
    } catch (failure) {
      if (signal?.aborted || activeToken.current !== session.token) return;
      if (failure.status === 401) {
        setSession(null);
        setData({ accounts: [], transfers: [] });
        setLoaded(false);
      }
      setError(failure.message);
    }
  }, [base, prefix, session]);

  useEffect(() => {
    if (!session) return undefined;
    const controller = new AbortController();
    const update = () => { if (document.visibilityState === 'visible') refresh(controller.signal); };
    refresh(controller.signal);
    const timer = setInterval(update, 12_000);
    document.addEventListener('visibilitychange', update);
    return () => {
      clearInterval(timer);
      controller.abort();
      document.removeEventListener('visibilitychange', update);
    };
  }, [session, refresh]);

  useEffect(() => {
    if (!session) return undefined;
    const controller = new AbortController();
    liveApi(base, '/directory/banks', { signal: controller.signal })
      .then(value => setDirectory(value.banks || []))
      .catch(failure => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [base, session]);

  function logout() {
    setSession(null);
    setVeloraToken(null);
    clearVeloraFirebaseSession();
    setLoaded(false);
    setData({ accounts: [], transfers: [] });
    setNote('');
    setActivePage('dashboard');
  }

  async function signIn(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const value = await liveApi(base, prefix + '/sign-in', { data: { email: email.trim(), password } });
      setSession(value);
      try {
        const individual = await signInToVeloraFirebase(email.trim(), password);
        if (individual.uid !== value.uid) throw new Error('The Firebase UID in Velora does not match the signed-in banking customer. Ask the bank administrator to verify the customer account mapping.');
        setVeloraToken(individual.idToken);
        setNote('Signed in to Velora Bank and its individual Firebase services.');
      } catch (individualError) {
        setVeloraToken(null);
        setNote('The existing banking login succeeded, but individual Velora services could not sign in: ' + individualError.message);
      }
    } catch (failure) { setError(failure.message); }
    finally { setPassword(''); setBusy(false); }
  }

  function connect(event) {
    event.preventDefault();
    setError('');
    try {
      const endpoint = parseEndpoint(url);
      if (endpoint !== base) { logout(); setDirectory([]); }
      saveStorage(localStorage, urlKey, endpoint);
      setBase(endpoint);
      setEditUrl(false);
    } catch (failure) { setError(failure.message); }
  }

  async function send(transfer) {
    const raw = JSON.stringify([bank.id, base, session.uid, transfer]);
    const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw)));
    const hash = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    const keyName = 'x42-pending-' + hash;
    const key = pending.current.get(keyName) || readStorage(sessionStorage, keyName, null) || crypto.randomUUID();
    pending.current.set(keyName, key);
    saveStorage(sessionStorage, keyName, key);
    const row = await liveApi(base, prefix + '/transfers', { token: session.token, data: transfer, key });
    pending.current.delete(keyName);
    saveStorage(sessionStorage, keyName, null);
    const verb = row.status === 'COMPLETED' ? 'Completed' : row.status === 'REJECTED' ? 'Rejected' :
      row.status === 'MANUAL_REVIEW' ? 'Manual review' : 'Accepted';
    setNote(verb + ' · ' + row.transferId);
    await refresh();
  }

  return <div className="layout live-bank-layout">
    <aside className="sidebar"><div className="brand"><span className="brand-icon"><Landmark size={23} /></span>
      <span><strong>{bank.wordmark}</strong><small>BANKING PORTAL</small></span></div>
      <nav aria-label="Bank actions">
        {session && <button className={activePage === 'dashboard' ? 'active' : ''} onClick={() => setActivePage('dashboard')}><Landmark size={18}/> Dashboard</button>}
        {session && <button className={activePage === 'beneficiaries' ? 'active' : ''} onClick={() => setActivePage('beneficiaries')}><Users size={18}/> Beneficiaries</button>}
        {session && <button className={activePage === 'transactions' ? 'active' : ''} onClick={() => setActivePage('transactions')}><List size={18}/> Transactions</button>}
        {session && <button className={activePage === 'accounts' ? 'active' : ''} onClick={() => setActivePage('accounts')}><Wallet size={18}/> My accounts</button>}
        {session && <button className={activePage === 'loans' ? 'active' : ''} onClick={() => setActivePage('loans')}><HandCoins size={18}/> Loans</button>}
        {session && <button className={activePage === 'overview' ? 'active' : ''} onClick={() => setActivePage('overview')}><ChartNoAxesCombined size={18}/> Overview</button>}
        {session && <button className={activePage === 'profile' ? 'active' : ''} onClick={() => setActivePage('profile')}><UserRound size={18}/> My profile</button>}
        {!configuredEndpoint && <button onClick={() => { setUrl(base); setEditUrl(!editUrl); }}><Globe2 size={18} /> Worker connection</button>}
        {openDemo && <button onClick={openDemo}><ArrowLeftRight size={18} /> Browser demo</button>}
        {session && <button onClick={logout}><LogOut size={18} /> Sign out</button>}
      </nav>
      
    </aside>
    <div className="main">
      <header className="topbar"><strong>{bank.name} · {bank.id}</strong></header>
      <main className="content live-bank-content">
        <div className="page-head"><div><h1>{session ? (activePage === 'dashboard' ? 'Accounts and transfers' : ({beneficiaries:'Beneficiaries',transactions:'Transaction history',accounts:'My accounts',loans:'Loan applications',overview:'Financial overview',profile:'My profile'}[activePage])) : 'Access your bank'}</h1>
          <p>{session ? 'Signed in as ' + session.email : 'Connect to the Worker and use your bank’s Firebase test login.'}</p>
        </div></div>
        {error && <Alert severity="error">{error}</Alert>}
        {note && <Alert severity="info" onClose={() => setNote('')}>{note}</Alert>}
        {editUrl && <section className="panel"><header className="panel-head"><div><h2>Worker connection</h2>
          <p>Use the same Cloudflare Worker URL across the bank pages.</p></div></header>
          <form className="transfer-form" onSubmit={connect}><TextField label="Cloudflare Worker URL" fullWidth required value={url} onChange={e => setUrl(e.target.value)} />
            <div><Button type="submit" variant="contained">Save connection</Button></div></form>
        </section>}
        {!session && base && !editUrl && <section className="panel live-sign-in"><header className="panel-head"><div><h2>Sign in to {bank.name}</h2>
          <p>Use a customer enabled in this bank’s Firebase project.</p></div></header>
          <form className="transfer-form" onSubmit={signIn}>
            <TextField label="Email" type="email" autoComplete="username" required value={email} onChange={event => setEmail(event.target.value)} />
            <TextField label="Password" type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} />
            <div><Button type="submit" variant="contained" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</Button></div>
          </form></section>}
        {session && activePage !== 'dashboard' && <VeloraFeaturePage page={activePage} bankId={bank.id} token={veloraToken} dashboard={data} onError={setError} onNotice={setNote}/>}
        {session && activePage === 'dashboard' && <>
          {loaded && !data.accounts.length && <Alert severity="info">This Firebase user has no synthetic account in this bank. Attach an account to this Firebase UID.</Alert>}
          {!loaded && <Alert severity="info">Loading your accounts and activity…</Alert>}
          <div className="accounts">{data.accounts.map((account, i) =>
            <section key={account.accountId} className={'account-card ' + (i === 0 ? 'primary-account' : 'light-account')}>
              <div className="account-head"><span>{account.accountNumber}</span><Landmark size={19} /></div>
              <div className="account-value">{money(account.availableMinor)}</div>
              <div className="account-foot"><span>Available · Held {money(account.heldMinor)}</span><span>{account.accountId}</span></div>
            </section>)}</div>
          {data.accounts.length > 0 && <TransferForm bank={bank} accounts={data.accounts} directory={directory} send={send} />}
          <Activity rows={data.transfers} directory={directory} />
        </>}
      </main>
    </div>
  </div>;
}
