import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
type Account = { id: string; name: string; balance: string; currency: string };
type Transfer = {
  id: string;
  sender_id: string;
  receiver_id: string;
  sender_name?: string;
  receiver_name?: string;
  amount: string;
  currency: string;
  status: string;
  created_at: string;
  idempotency_key: string;
  failure_code: string | null;
  reverse_of: string | null;
  reversal_id: string | null;
  entries?: Entry[];
};
type Entry = {
  id: string;
  account_id: string;
  direction: string;
  amount: string;
  created_at: string;
};
type Balance = { id: string; name: string; stored_balance: string; ledger_balance: string };
type Report = {
  id: string;
  created_at: string;
  balanced: boolean;
  matches: boolean;
  total_debits: string;
  total_credits: string;
  account_count: number;
  mismatches: Balance[];
  balances: Balance[];
};
const money = (v: string) => {
  const n = BigInt(v),
    abs = n < 0n ? -n : n;
  return `${n < 0n ? '−' : ''}$${new Intl.NumberFormat('en-US').format(abs / 100n)}.${String(abs % 100n).padStart(2, '0')}`;
};
const time = (v: string) =>
  new Date(v).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  const data = await res.json();
  if (!res.ok) {
    throw new HttpError(
      res.status,
      data.transfer?.failure_code?.replaceAll('_', ' ') || data.message || 'Request failed',
    );
  }
  return data;
}
function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    grid: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
        <rect x="14" y="14" width="7" height="7" rx="1.5" />
      </>
    ),
    wallet: (
      <>
        <path d="M20 8V5a2 2 0 0 0-2-2H5a3 3 0 0 0 0 6h15v11H5a3 3 0 0 1-3-3V6" />
        <path d="M20 12h-5v5h5" />
      </>
    ),
    arrows: (
      <>
        <path d="M4 7h15m-4-4 4 4-4 4M20 17H5m4-4-4 4 4 4" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    shield: (
      <>
        <path d="m12 2 8 3v6c0 5-8 11-8 11S4 16 4 11V5z" />
        <path d="m8 11 3 3 5-6" />
      </>
    ),
    arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
    plus: <path d="M12 5v14M5 12h14" />,
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    close: <path d="m6 6 12 12M6 18 18 6" />,
    book: (
      <>
        <path d="M4 3h13a3 3 0 0 1 3 3v15H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3zm0 13h16M8 7h8M8 11h5" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] || paths.grid}
    </svg>
  );
}
function App() {
  const [page, setPage] = useState('Overview'),
    [accounts, setAccounts] = useState<Account[]>([]),
    [transfers, setTransfers] = useState<Transfer[]>([]),
    [reports, setReports] = useState<Report[]>([]),
    [selected, setSelected] = useState<Transfer | null>(null),
    [newAccount, setNewAccount] = useState(false),
    [name, setName] = useState(''),
    [sender, setSender] = useState(''),
    [receiver, setReceiver] = useState(''),
    [amount, setAmount] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [ready, setReady] = useState(false),
    [offset, setOffset] = useState(0);
  const pending = useRef<{ fingerprint: string; key: string } | null>(null);
  const reversalKeys = useRef<Record<string, string>>({});
  async function refresh(at = offset) {
    const [a, t, r] = await Promise.all([
      api<{ accounts: Account[] }>('/accounts'),
      api<{ transfers: Transfer[] }>(`/transfers?limit=20&offset=${at}`),
      api<{ reports: Report[] }>('/reconciliation'),
    ]);
    setAccounts(a.accounts);
    setTransfers(t.transfers);
    setReports(r.reports);
    setReady(true);
  }
  useEffect(() => {
    refresh().catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    if (accounts.length) {
      setSender((s) => s || accounts[0].id);
      setReceiver((s) => s || accounts[1]?.id || '');
    }
  }, [accounts]);
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed');
      await refresh().catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setNewAccount(false);
        setSelected(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const latest = reports[0];
  const total = accounts.reduce((s, a) => s + BigInt(a.balance), 0n);
  async function send(e: React.FormEvent) {
    e.preventDefault();
    await action(async () => {
      if (!/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(amount))
        throw new Error('Enter a positive USD amount with up to two decimal places.');
      const [whole, part = ''] = amount.split('.');
      const minor = (BigInt(whole) * 100n + BigInt(part.padEnd(2, '0'))).toString();
      if (BigInt(minor) < 1n) throw new Error('Amount must be at least $0.01');
      const body = JSON.stringify({
        senderId: sender,
        receiverId: receiver,
        amount: minor,
        currency: 'USD',
      });
      if (pending.current?.fingerprint !== body)
        pending.current = { fingerprint: body, key: crypto.randomUUID() };
      const result = await api<{ transfer: Transfer; replayed: boolean }>('/transfers', {
        method: 'POST',
        headers: { 'Idempotency-Key': pending.current.key },
        body,
      }).catch((e) => {
        if (e instanceof HttpError && e.status === 422) pending.current = null;
        throw e;
      });
      pending.current = null;
      setAmount('');
      setNotice(
        result.replayed
          ? 'Original transfer returned. No duplicate money movement.'
          : 'Transfer completed. Two entries posted to the ledger.',
      );
      setOffset(0);
      await refresh(0);
    });
  }
  async function detail(id: string) {
    await action(async () => setSelected(await api<Transfer>(`/transfers/${id}`)));
  }
  async function reverse(t: Transfer) {
    await action(async () => {
      const key = (reversalKeys.current[t.id] ??= crypto.randomUUID());
      await api(`/transfers/${t.id}/reverse`, {
        method: 'POST',
        headers: { 'Idempotency-Key': key },
        body: '{}',
      }).catch((e) => {
        if (e instanceof HttpError && e.status === 422) delete reversalKeys.current[t.id];
        throw e;
      });
      delete reversalKeys.current[t.id];
      setSelected(await api<Transfer>(`/transfers/${t.id}`));
      setNotice('Reversal posted as a new balanced transfer.');
      await refresh();
    });
  }
  const nav = ['Overview', 'Accounts', 'Transfers', 'Reconciliation'];
  return (
    <div className="shell">
      <aside>
        <a className="brand" href="#" onClick={() => setPage('Overview')}>
          <span className="brandmark">ll</span>ledgerline<span className="branddot">.</span>
        </a>
        <div className="workspace">
          <span className="workspace-icon">L</span>
          <div>
            Ledgerline workspace<small>Development environment</small>
          </div>
          <span className="chevron">⌄</span>
        </div>
        <div className="nav-label">WORKSPACE</div>
        <nav>
          {nav.map((n, i) => (
            <button
              key={n}
              className={page === n ? 'active' : ''}
              onClick={() => {
                setPage(n);
                setOffset(0);
                refresh(0).catch((e) => setError(e.message));
              }}
            >
              <Icon name={['grid', 'wallet', 'arrows', 'shield'][i]} />
              {n}
              {page === n && <span className="nav-dot" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="invariant">
            <Icon name="shield" />
            <strong>Every cent, accounted for.</strong>
            <p>
              Balanced entries. Immutable history.
              <br />
              One source of truth.
            </p>
          </div>
          <div className="environment">
            <span className="live-dot" /> Sandbox <span>USD only</span>
          </div>
          <div className="profile">
            <span>LL</span>
            <div>
              Demo workspace<small>No real money</small>
            </div>
            <span className="version">v1.0</span>
          </div>
        </div>
      </aside>
      <main>
        <header>
          <div className="breadcrumb">
            Workspace <span>/</span> <b>{page}</b>
          </div>
          <span className="sandbox">
            <span className="live-dot" /> SANDBOX MODE
          </span>
        </header>
        <div className="content">
          <div className="heading">
            <div>
              <div className="eyebrow">PAYMENTS, ACCOUNTED FOR</div>
              <h1>
                {page === 'Overview'
                  ? 'Your money in motion.'
                  : page === 'Accounts'
                    ? 'A place for every balance.'
                    : page === 'Transfers'
                      ? 'The complete paper trail.'
                      : 'Trust, then verify.'}
              </h1>
              <p>
                {page === 'Overview'
                  ? 'A clear view of your accounts, transfers, and ledger health.'
                  : page === 'Accounts'
                    ? 'Wallet balances backed by an immutable double-entry ledger.'
                    : page === 'Transfers'
                      ? 'Every movement, every entry. Including the ones that didn’t go through.'
                      : 'Rebuild every balance from the journal and compare it to the cache.'}
              </p>
            </div>
            <button className="button secondary" onClick={() => setNewAccount(true)}>
              <Icon name="plus" size={17} />
              Create account
            </button>
          </div>
          {error && (
            <div role="alert" className="alert error">
              <strong>Request failed</strong> · {error}
              <button aria-label="Dismiss error" onClick={() => setError('')}>
                ×
              </button>
            </div>
          )}
          {notice && (
            <div role="status" className="alert success">
              <Icon name="check" size={17} />
              {notice}
              <button aria-label="Dismiss notification" onClick={() => setNotice('')}>
                ×
              </button>
            </div>
          )}
          {!ready && !error && <div className="empty">Connecting to the ledger…</div>}
          {(page === 'Overview' || page === 'Accounts') && (
            <>
              <div className="stats">
                <div className="stat">
                  <div>
                    Total wallet balance
                    <Icon name="wallet" />
                  </div>
                  <strong>{money(total.toString())}</strong>
                  <small>
                    <span className="live-dot" />
                    Across {accounts.length} USD accounts
                  </small>
                </div>
                <div className="stat">
                  <div>
                    Active accounts
                    <Icon name="grid" />
                  </div>
                  <strong>{String(accounts.length).padStart(2, '0')}</strong>
                  <small>Each with a dedicated ledger</small>
                </div>
                <div className="stat health">
                  <div>
                    Ledger health
                    <Icon name="shield" />
                  </div>
                  <strong>
                    {latest
                      ? latest.balanced && latest.matches
                        ? 'Reconciled'
                        : 'Needs review'
                      : 'Not checked'}
                    {latest?.matches && latest.balanced && (
                      <span className="check-circle">
                        <Icon name="check" size={16} />
                      </span>
                    )}
                  </strong>
                  <small>
                    {latest
                      ? `Last checked ${time(latest.created_at)}`
                      : 'Run your first reconciliation'}
                  </small>
                </div>
              </div>
              <div className="section-head">
                <h2>
                  Your accounts <span>{accounts.length}</span>
                </h2>
                <span className="muted">Balances in USD</span>
              </div>
              <div className="account-grid">
                {accounts.map((a, i) => (
                  <article className="account-card" key={a.id}>
                    <div className="account-top">
                      <span className={`account-icon color-${i % 3}`}>
                        <Icon name="wallet" />
                      </span>
                      <span className="currency">USD</span>
                    </div>
                    <h3>{a.name}</h3>
                    <strong>{money(a.balance)}</strong>
                    <div className="account-foot">
                      <span title={a.id}>
                        {a.id.slice(0, 8)}…{a.id.slice(-4)}
                      </span>
                      <span>
                        <span className="live-dot" />
                        Active
                      </span>
                    </div>
                  </article>
                ))}
                {!accounts.length && (
                  <div className="empty">
                    No accounts yet. Create a wallet or run the demo seed.
                  </div>
                )}
              </div>
            </>
          )}
          {(page === 'Overview' || page === 'Transfers') && (
            <div className={`activity-layout ${page === 'Transfers' ? 'history-only' : ''}`}>
              <section className="panel history">
                <div className="panel-head">
                  <div>
                    <h2>Transfer activity</h2>
                    <p>The immutable record of money movement</p>
                  </div>
                  <span className="pill neutral">
                    <span className="live-dot" /> Live ledger
                  </span>
                </div>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>TRANSFER</th>
                        <th>AMOUNT</th>
                        <th>STATUS</th>
                        <th>DATE</th>
                        <th>
                          <span className="sr-only">Details</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {transfers.map((t) => (
                        <tr key={t.id} onClick={() => void detail(t.id)}>
                          <td>
                            <div className="transfer-cell">
                              <span
                                className={`transfer-icon ${t.status === 'rejected' ? 'failed' : ''}`}
                              >
                                <Icon name="arrows" size={16} />
                              </span>
                              <div>
                                <strong>
                                  {t.reverse_of ? 'Reversal · ' : ''}
                                  {t.sender_name}
                                </strong>
                                <small>to {t.receiver_name}</small>
                              </div>
                            </div>
                          </td>
                          <td className="amount">{money(t.amount)}</td>
                          <td>
                            <span
                              className={`pill ${t.status === 'rejected' ? 'rejected' : t.reversal_id ? 'neutral' : 'completed'}`}
                            >
                              {t.status === 'rejected'
                                ? 'Rejected'
                                : t.reversal_id
                                  ? 'Reversed'
                                  : 'Completed'}
                            </span>
                          </td>
                          <td className="date">{time(t.created_at)}</td>
                          <td>
                            <button
                              className="icon-button"
                              aria-label={`View transfer ${t.id}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                void detail(t.id);
                              }}
                            >
                              <Icon name="arrow" size={16} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!transfers.length && (
                    <div className="empty">
                      <Icon name="book" size={28} />
                      <strong>Your ledger starts here</strong>
                      <p>Make a transfer to see its journal entries.</p>
                    </div>
                  )}
                </div>
                <div className="table-footer">
                  <span>
                    {offset + 1}–{offset + transfers.length} · Latest journal activity
                  </span>
                  <div>
                    <button
                      disabled={busy || offset === 0}
                      onClick={() =>
                        void action(async () => {
                          setOffset(Math.max(0, offset - 20));
                          await refresh(Math.max(0, offset - 20));
                        })
                      }
                    >
                      Previous
                    </button>
                    <button
                      disabled={busy || transfers.length < 20}
                      onClick={() =>
                        void action(async () => {
                          setOffset(offset + 20);
                          await refresh(offset + 20);
                        })
                      }
                    >
                      Next
                    </button>
                  </div>
                </div>
              </section>
              <section className="panel transfer-form">
                <div className="panel-head">
                  <div>
                    <h2>Move money</h2>
                    <p>Between your USD accounts</p>
                  </div>
                  <Icon name="arrows" />
                </div>
                <form onSubmit={send}>
                  <label>
                    From account
                    <select value={sender} onChange={(e) => setSender(e.target.value)} required>
                      {!accounts.length && <option value="">Select account</option>}
                      {accounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="available">
                    Available <b>{money(accounts.find((a) => a.id === sender)?.balance || '0')}</b>
                  </div>
                  <label>
                    To account
                    <select value={receiver} onChange={(e) => setReceiver(e.target.value)} required>
                      <option value="">Select destination</option>
                      {accounts
                        .filter((a) => a.id !== sender)
                        .map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label>
                    Amount
                    <div className="amount-input">
                      <span>$</span>
                      <input
                        aria-label="Amount in USD"
                        inputMode="decimal"
                        placeholder="0.00"
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                        required
                      />
                      <span>USD</span>
                    </div>
                  </label>
                  <button
                    className="button primary"
                    disabled={busy || accounts.length < 2 || sender === receiver}
                    type="submit"
                  >
                    {busy ? 'Processing…' : 'Transfer funds'}
                    <Icon name="arrow" size={17} />
                  </button>
                  <div className="form-note">
                    <Icon name="shield" size={15} />
                    Idempotent by design. Balanced by default.
                  </div>
                </form>
              </section>
            </div>
          )}
          {(page === 'Overview' || page === 'Reconciliation') && (
            <>
              <div className="reconcile-banner">
                <span className="reconcile-icon">
                  <Icon name="shield" size={25} />
                </span>
                <div>
                  <h3>
                    {latest?.balanced && latest?.matches
                      ? 'A balanced ledger is a healthy ledger.'
                      : 'Give your ledger a health check.'}
                  </h3>
                  <p>
                    {latest
                      ? `${latest.account_count} accounts checked · ${latest.mismatches.length} balance mismatches · ${latest.balanced ? 'Debits equal credits' : 'Debits and credits differ'}`
                      : 'Recompute balances from every entry. Nothing is assumed.'}
                  </p>
                </div>
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      await api('/reconciliation', { method: 'POST', body: '{}' });
                      await refresh();
                      setNotice('Reconciliation report saved.');
                    })
                  }
                >
                  Run reconciliation
                  <Icon name="arrow" size={16} />
                </button>
              </div>
              {page === 'Reconciliation' && (
                <section className="panel reports">
                  <div className="panel-head">
                    <div>
                      <h2>Reconciliation reports</h2>
                      <p>A consistent database snapshot, persisted for audit</p>
                    </div>
                  </div>
                  {reports.map((r) => (
                    <details key={r.id}>
                      <summary>
                        <span>{time(r.created_at)}</span>
                        <span>
                          {r.account_count} accounts · {r.mismatches.length} mismatches
                        </span>
                        <span
                          className={`pill ${r.balanced && r.matches ? 'completed' : 'rejected'}`}
                        >
                          {r.balanced && r.matches ? 'Passed' : 'Mismatch'}
                        </span>
                      </summary>
                      <div className="report-body">
                        <p>
                          Total debits <b>{money(r.total_debits)}</b> · Total credits{' '}
                          <b>{money(r.total_credits)}</b>
                        </p>
                        <div className="table-scroll">
                          <table>
                            <thead>
                              <tr>
                                <th>ACCOUNT</th>
                                <th>STORED</th>
                                <th>LEDGER</th>
                                <th>RESULT</th>
                              </tr>
                            </thead>
                            <tbody>
                              {r.balances.map((a) => (
                                <tr key={a.id}>
                                  <td>{a.name}</td>
                                  <td>{money(a.stored_balance)}</td>
                                  <td>{money(a.ledger_balance)}</td>
                                  <td>
                                    {a.stored_balance === a.ledger_balance ? 'Match' : 'Mismatch'}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        <code>Report {r.id}</code>
                      </div>
                    </details>
                  ))}
                  {!reports.length && <div className="empty">No reconciliation reports yet.</div>}
                </section>
              )}
            </>
          )}
          <footer>
            <span>
              <span className="live-dot" /> PostgreSQL ledger · USD
            </span>
            <span>Demo environment. No real money. Not PCI compliant.</span>
          </footer>
        </div>
      </main>
      {newAccount && (
        <div className="modal-backdrop" onClick={() => setNewAccount(false)}>
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="account-title"
            className="modal"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="modal-close icon-button"
              aria-label="Close dialog"
              onClick={() => setNewAccount(false)}
            >
              <Icon name="close" />
            </button>
            <span className="account-icon color-0">
              <Icon name="wallet" />
            </span>
            <h2 id="account-title">Create a USD wallet</h2>
            <p>New accounts start at $0.00. Move demo funds from an existing wallet.</p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void action(async () => {
                  await api('/accounts', {
                    method: 'POST',
                    body: JSON.stringify({ name, currency: 'USD' }),
                  });
                  setName('');
                  setNewAccount(false);
                  await refresh();
                  setNotice('Account created.');
                });
              }}
            >
              <label>
                Account name
                <input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={80}
                  required
                  placeholder="e.g. Customer payouts"
                />
              </label>
              <button className="button primary" disabled={busy}>
                Create account
                <Icon name="plus" size={17} />
              </button>
            </form>
          </section>
        </div>
      )}
      {selected && (
        <div className="modal-backdrop" onClick={() => setSelected(null)}>
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="transfer-title"
            className="modal detail"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="modal-close icon-button"
              aria-label="Close dialog"
              onClick={() => setSelected(null)}
            >
              <Icon name="close" />
            </button>
            <div className="eyebrow">IMMUTABLE AUDIT RECORD</div>
            <h2 id="transfer-title">Transfer detail</h2>
            <div className="detail-amount">
              {money(selected.amount)}{' '}
              <span
                className={`pill ${selected.status === 'completed' ? 'completed' : 'rejected'}`}
              >
                {selected.reversal_id ? 'Reversed' : selected.status}
              </span>
            </div>
            <dl>
              <dt>Transfer ID</dt>
              <dd>{selected.id}</dd>
              <dt>Created</dt>
              <dd>{time(selected.created_at)}</dd>
              <dt>Idempotency key</dt>
              <dd>{selected.idempotency_key}</dd>
              <dt>From</dt>
              <dd>
                {accounts.find((a) => a.id === selected.sender_id)?.name || selected.sender_id}
              </dd>
              <dt>To</dt>
              <dd>
                {accounts.find((a) => a.id === selected.receiver_id)?.name || selected.receiver_id}
              </dd>
              {selected.failure_code && (
                <>
                  <dt>Failure</dt>
                  <dd>{selected.failure_code}</dd>
                </>
              )}
              {selected.reverse_of && (
                <>
                  <dt>Reverses</dt>
                  <dd>
                    <button
                      className="text-button"
                      onClick={() => void detail(selected.reverse_of!)}
                    >
                      {selected.reverse_of}
                    </button>
                  </dd>
                </>
              )}
              {selected.reversal_id && (
                <>
                  <dt>Reversal</dt>
                  <dd>
                    <button
                      className="text-button"
                      onClick={() => void detail(selected.reversal_id!)}
                    >
                      {selected.reversal_id}
                    </button>
                  </dd>
                </>
              )}
            </dl>
            <h3>Journal entries</h3>
            {selected.entries?.map((e) => (
              <div className="entry" key={e.id}>
                <div>
                  <span className={`pill ${e.direction === 'credit' ? 'completed' : 'neutral'}`}>
                    {e.direction}
                  </span>
                  <small>{accounts.find((a) => a.id === e.account_id)?.name || e.account_id}</small>
                </div>
                <strong>
                  {e.direction === 'debit' ? '−' : '+'}
                  {money(e.amount)}
                </strong>
                <small>
                  {time(e.created_at)} · Entry #{e.id}
                </small>
              </div>
            ))}
            {!selected.entries?.length && <p>No entries posted. No money moved.</p>}
            {selected.status === 'completed' && !selected.reverse_of && !selected.reversal_id && (
              <button
                className="button secondary reverse-button"
                disabled={busy || selected.idempotency_key.startsWith('seed-')}
                onClick={() => void reverse(selected)}
              >
                Reverse transfer
                <Icon name="arrows" size={17} />
              </button>
            )}
            <p className="detail-note">
              Reversals create a new journal. This record is never edited.
            </p>
          </section>
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
